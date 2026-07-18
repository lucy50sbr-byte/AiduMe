let currentAnime = null;
let playbackStartTime = 0;
let progresoIntervalGlobal = null; // Para limpiar intervalos anteriores al cambiar de video

let duelAnimes = [];
let paginaActualTodos = 1;
let idiomaActual = 'sub';
let ultimoEpisodioCargado = null;
let privateChatSubscription = null; // Variable global para la suscripción al chat privado
let lastAppVersionChecked = null; // Para controlar la versión de la app
let paginaFiltros = 1;
let chatAmigoActual = null; // Usuario con el que se chatea en privado
let wpChatChannel = null; // Canal de chat temporal
let urlTransmisionActual = null; // URL para enviar a la TV
let playbackSessionId = 0; // Sesión activa de reproducción para evitar cruce de anuncios

// --- CACHÉ DE JIKAN PARA CARGA RÁPIDA ---
const _jikanCache = {};

// --- CACHÉ DE ANILIST PARA RESPALDO ---
const _anilistCache = {};

/**
 * Helper: Realiza fetch con timeout y devuelve { ok, data, error, source }
 * Primero intenta Jikan, si falla intenta Anilist como respaldo.
 * @param {string} jikanUrl - URL de Jikan
 * @param {Function} anilistFallback - Función asíncrona que hace la consulta a Anilist
 */
async function fetchWithFallback(jikanUrl, anilistFallback, cacheKey = null) {
    // 1. Intentar Jikan primero
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    try {
        const res = await fetch(jikanUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            // Si es 504 (MAL caído) o 429 (rate limit), lanzamos para ir al fallback
            throw new Error(`HTTP ${res.status}`);
        }
        
        const json = await res.json();
        if (json.data && json.data.length > 0) {
            if (cacheKey) _jikanCache[cacheKey] = json.data;
            return { ok: true, data: json.data, pagination: json.pagination, source: 'jikan' };
        }
        throw new Error("Empty data from Jikan");
    } catch (err) {
        clearTimeout(timeoutId);
        console.warn("Jikan falló, intentando Anilist como respaldo:", err.message);
        
        // 2. Fallback a Anilist
        try {
            const anilistData = await anilistFallback();
            if (anilistData && anilistData.length > 0) {
                if (cacheKey) _anilistCache[cacheKey] = anilistData;
                return { ok: true, data: anilistData, pagination: null, source: 'anilist' };
            }
            throw new Error("Empty data from Anilist");
        } catch (fallbackErr) {
            console.error("Anilist también falló:", fallbackErr.message);
            return { ok: false, data: null, pagination: null, source: 'none', error: fallbackErr.message };
        }
    }
}

/**
 * Adaptador: Convierte datos de Anilist al formato MAL-like que usa la app
 */
function adaptAnilistToMALFormat(anilistData) {
    if (!anilistData || !Array.isArray(anilistData)) return [];
    return anilistData.map(item => ({
        mal_id: item.idMal || item.id,
        title: item.title?.romaji || item.title?.english || item.title?.native || "Sin título",
        titles: [
            { type: 'Default', title: item.title?.romaji },
            { type: 'English', title: item.title?.english }
        ].filter(t => t.title),
        images: {
            jpg: {
                image_url: item.coverImage?.large || item.coverImage?.medium || 'placeholder.png',
                large_image_url: item.coverImage?.extraLarge || item.coverImage?.large || 'placeholder.png',
                small_image_url: item.coverImage?.medium || 'placeholder.png'
            }
        },
        synopsis: item.description || "Sin descripción disponible.",
        episodes: item.episodes || 0,
        status: item.status === 'RELEASING' ? 'Currently Airing' : 
                item.status === 'FINISHED' ? 'Finished Airing' : 'Not yet aired',
        score: item.averageScore ? (item.averageScore / 20) : 0,
        type: item.format || 'TV',
        season: item.season || null,
        year: item.seasonYear || null,
        genres: item.genres || [],
        _viewCount: 0,
        _source: 'anilist'
    }));
}

/**
 * Consulta a Anilist para obtener un anime específico por su MAL ID
 */
async function fetchAnilistByMalId(malId) {
    const graphqlQuery = `
    query ($idMal: Int) {
      Media(idMal: $idMal, type: ANIME) {
        id
        idMal
        title { romaji english native }
        coverImage { extraLarge large medium }
        description
        episodes
        status
        averageScore
        format
        season
        seasonYear
        genres
      }
    }`;
    
    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: graphqlQuery, variables: { idMal: malId } })
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (json.data?.Media) {
            return adaptAnilistToMALFormat([json.data.Media])[0];
        }
        return null;
    } catch (e) {
        console.warn(`Anilist fetch failed for MAL ID ${malId}:`, e);
        return null;
    }
}

/**
 * Obtiene metadatos de múltiples animes desde Anilist por lotes (máximo 50 por consulta)
 */
async function fetchAnilistBatch(malIds) {
    if (!malIds || malIds.length === 0) return {};
    
    const results = {};
    const toFetch = malIds.filter(id => {
        if (_anilistCache[id]) { results[id] = _anilistCache[id]; return false; }
        return true;
    });
    
    if (toFetch.length === 0) return results;
    
    // Anilist permite consultar hasta 50 por vez con MEDIA_TRENDING
    // Pero para IDs específicos, hacemos consultas individuales en paralelo (lotes de 5)
    for (let i = 0; i < toFetch.length; i += 5) {
        const batch = toFetch.slice(i, i + 5);
        const promises = batch.map(id => fetchAnilistByMalId(id));
        const batchResults = await Promise.all(promises);
        batch.forEach((id, idx) => {
            if (batchResults[idx]) {
                results[id] = batchResults[idx];
                _anilistCache[id] = batchResults[idx];
            }
        });
        if (i + 5 < toFetch.length) await new Promise(r => setTimeout(r, 200));
    }
    return results;
}

/**
 * Consulta a Anilist para búsqueda por texto
 */
async function searchAnilist(query, page = 1, perPage = 24) {
    const graphqlQuery = `
    query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(search: $search, sort: POPULARITY_DESC, type: ANIME) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium }
          description
          episodes
          status
          averageScore
          format
          season
          seasonYear
          genres
        }
      }
    }`;
    
    const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: graphqlQuery, variables: { search: query, page, perPage } })
    });
    
    if (!res.ok) throw new Error(`Anilist search HTTP ${res.status}`);
    const json = await res.json();
    return adaptAnilistToMALFormat(json.data?.Page?.media || []);
}

/**
 * Consulta a Anilist para listado por popularidad/página
 */
async function listAnilist(page = 1, perPage = 24) {
    const graphqlQuery = `
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(sort: POPULARITY_DESC, type: ANIME) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium }
          description
          episodes
          status
          averageScore
          format
          season
          seasonYear
          genres
        }
      }
    }`;
    
    const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: graphqlQuery, variables: { page, perPage } })
    });
    
    if (!res.ok) throw new Error(`Anilist list HTTP ${res.status}`);
    const json = await res.json();
    return adaptAnilistToMALFormat(json.data?.Page?.media || []);
}

/**
 * Obtiene datos de un anime desde Jikan con caché en memoria.
 * Si ya se pidió antes, devuelve el resultado cacheado instantáneamente.
 */
async function fetchJikanCached(malId) {
    if (_jikanCache[malId]) return _jikanCache[malId];
    try {
        const res = await fetch(`https://api.jikan.moe/v4/anime/${malId}`);
        if (res.ok) {
            const json = await res.json();
            if (json.data) {
                _jikanCache[malId] = json.data;
                return json.data;
            }
        }
    } catch (e) {
        console.warn(`Jikan fetch failed for ${malId}:`, e);
    }
    return null;
}

/**
 * Obtiene datos de múltiples anime en paralelo por lotes de 3
 * (respetando el rate limit de Jikan de 3 req/seg).
 */
async function fetchJikanBatch(malIds) {
    const results = {};
    const toFetch = malIds.filter(id => {
        if (_jikanCache[id]) { results[id] = _jikanCache[id]; return false; }
        return true;
    });

    // Procesar en lotes de 3 en paralelo
    for (let i = 0; i < toFetch.length; i += 3) {
        const batch = toFetch.slice(i, i + 3);
        const promises = batch.map(id => fetchJikanCached(id));
        const batchResults = await Promise.all(promises);
        batch.forEach((id, idx) => {
            if (batchResults[idx]) results[id] = batchResults[idx];
        });
        // Solo esperar si hay más lotes por procesar
        if (i + 3 < toFetch.length) await new Promise(r => setTimeout(r, 350));
    }
    return results;
}

// Lista de palabras que activarán la alerta roja
const PALABRAS_PROHIBIDAS = ["insulto1", "insulto2", "spam", "ofensa"];

// Global variable to store the current day's date string (YYYY-MM-DD)
let currentDayString = '';

// Function to get the current day in YYYY-MM-DD format
function getTodayString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}${month}${day}`; // Devuelve YYYYMMDD (ej: 20260507) compatible con INTEGER
}

// Function to get yesterday's date in YYYY-MM-DD format
function getYesterdayString() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}${(d.getMonth() + 1).toString().padStart(2, '0')}${d.getDate().toString().padStart(2, '0')}`;
}

function parsearMensajeParaStickers(texto) {
    if (!texto) return "";
    let nuevoTexto = texto.replace(/\[STK:([^\]]+)\]/g, '<img src="$1" class="chat-sticker">');
    // Regex para detectar invitaciones a Watch Party
    const wpRegex = /\[WP_INVITE:([^:]+):([^:]+):([^\]]+)\]/g;
    nuevoTexto = nuevoTexto.replace(wpRegex, (match, animeId, epNum, hostName) => {
        return `<button onclick="unirseAWatchPartyDesdeChat('${animeId}', '${epNum}', '${hostName}')" class="btn-random-gold" style="margin-top:5px; padding: 4px 8px; font-size:0.7rem; width:100%;">🍿 Unirse a Sala de ${hostName}</button>`;
    });
    return nuevoTexto;
}

async function initApp() {
    currentDayString = getTodayString(); // Initialize current day string
    await cargarDuelo();
    cargarHome();
    cargarSeccionContinuarViendo(); // Cargar sección "Continuar viendo"
    cargarUltimosEpisodios();
    cargarTodosLosAnimes(1); // Carga inicial de la lista completa
    cargarGenerosEnPanel();
    activarNotificacionesEnVivo();
    iniciarContadorOnline();
    verificarRachaDias();
    
    // --- ESTADO ONLINE ---
    actualizarEstadoConexion(); 
    setInterval(actualizarEstadoConexion, 60000); // Actualiza cada 1 min
    
    checkForAppUpdate(); // Verifica actualizaciones al iniciar
    setInterval(cargarUltimosEpisodios, 600000); // Refresca episodios cada 10 min
    setInterval(cargarHome, 604800000); // Actualización automática del Top 10 cada semana (7 días)

    escucharSolicitudesAmistad();
    iniciarCanalDedicadoUsuario();
    actualizarNotificacionesPerfil(); 
    escucharNotificacionesGlobales();

    // Refrescar automáticamente la vista de perfil (estados online) si está abierta
    setInterval(() => {
        const perfilPage = document.getElementById('perfil');
        if (perfilPage && perfilPage.classList.contains('active-page')) {
            // Ahora refrescamos el perfil que esté realmente en pantalla
            actualizarPerfilDesdeSQL(usuarioEnPantalla || currentUser);
        }
    }, 300000); // Cada 5 minutos

    // NEW: Check for daily tournament winner and distribute rewards
    verificarGanadorDiario();
    setInterval(verificarGanadorDiario, 3600000); // Check every hour to catch up if the app wasn't open at midnight

    // Auto-abrir anime desde notificación
    const params = new URLSearchParams(window.location.search);
    const openId = params.get('openAnime');
    if (openId) {
        // Limpiamos la URL para que no se repita al recargar
        window.history.replaceState(null, null, window.location.pathname);
        showDetails({ mal_id: parseInt(openId) });
    }

    // --- SOPORTE PARA TECLA ENTER EN TODA LA APP ---
    const inputsEnter = [
        { id: 'busqueda', fn: buscarAnimeFusion },
        { id: 'chat-input', fn: enviarMensajeChat },
        { id: 'comment-input', fn: postearComentario },
        { id: 'privado-input', fn: enviarMensajePrivado },
        { id: 'wp-input-msg', fn: enviarMsgWatchParty },
        { id: 'input-bio-nueva', fn: guardarNuevaBio }
    ];

    inputsEnter.forEach(item => {
        const el = document.getElementById(item.id);
        if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') item.fn(); });
    });
}

// ===== SISTEMA DE DETECCIÓN DE CONEXIÓN (OFFLINE OVERLAY) =====
function mostrarOverlayOffline() {
    const overlay = document.getElementById('offline-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        // Iniciar contador de reconexión automática (10 segundos)
        let segundos = 10;
        const countdownEl = document.getElementById('offline-countdown');
        const interval = setInterval(() => {
            segundos--;
            if (countdownEl) countdownEl.innerText = segundos;
            if (segundos <= 0) {
                clearInterval(interval);
                location.reload();
            }
        }, 1000);
    }
}

function ocultarOverlayOffline() {
    const overlay = document.getElementById('offline-overlay');
    if (overlay) overlay.style.display = 'none';
}

function verificarConexionApp() {
    if (!navigator.onLine) {
        mostrarOverlayOffline();
        return false;
    }
    return true;
}

// Escuchar eventos de conexión/desconexión
window.addEventListener('online', () => {
    ocultarOverlayOffline();
    location.reload(); // Recargar al recuperar conexión
});

window.addEventListener('offline', () => {
    mostrarOverlayOffline();
});

// --- MEJORA: Intento de cierre automático al cerrar ventana ---
window.addEventListener('beforeunload', () => {
    if (currentUser) {
        // Usamos fetch con keepalive para asegurar que la petición se complete 
        // incluso si la pestaña se cierra instantáneamente.
        const url = `${_supabaseUrl}/rest/v1/perfiles?nombre=ilike.${encodeURIComponent(currentUser.trim())}`;
        fetch(url, {
            method: 'PATCH',
            headers: {
                'apikey': _supabaseKey,
                'Authorization': `Bearer ${_supabaseKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ online: false }),
            keepalive: true
        });
    }
});

async function cargarHome() {
    const lista = document.getElementById('lista-top-10');
    if (!lista) return;

    try {
        // 1. Obtenemos todos los registros de la tabla relacional limpia
        const { data: registrosVistos, error } = await _db
            .from('vistos')
            .select('anime_id');
        
        if (error) throw error;

        if (!registrosVistos || registrosVistos.length === 0) {
            lista.innerHTML = '<p style="text-align:center; opacity:0.5; padding:20px; width:100%;">Aún no hay datos de visualización.</p>';
            return;
        }

        // 2. Contamos cuántas veces se vio cada anime_id
        const conteoVistas = {};
        registrosVistos.forEach(reg => {
            const id = reg.anime_id;
            if (!id) return;
            conteoVistas[id] = (conteoVistas[id] || 0) + 1;
        });

        // 3. Ordenamos y tomamos los 10 IDs más vistos
        const top10Ids = Object.keys(conteoVistas)
            .sort((a, b) => conteoVistas[b] - conteoVistas[a])
            .slice(0, 10)
            .map(id => parseInt(id));

        // 4. Obtenemos la metadata usando la caché (¡Súper rápido!)
        const metadataMap = await fetchJikanBatchConCache(top10Ids);

        // 5. Construimos la lista final con los animes que logramos resolver
        const top10Animes = top10Ids
            .filter(id => metadataMap[id])
            .map(id => metadataMap[id]);

        if (top10Animes.length === 0) {
            lista.innerHTML = '<p style="text-align:center; opacity:0.5; padding:20px; width:100%;">Aún no hay datos de visualización.</p>';
            return;
        }

        // 6. Renderizamos en la UI
        renderGrid(top10Animes, 'lista-top-10');

    } catch (e) {
        console.error("Error al cargar el home:", e);
        lista.innerHTML = '<p style="text-align:center; color:#ff4444; padding:20px; font-size:0.8rem; width:100%;">⚠️ No pudimos cargar los animes.</p>';
    }
}

/**
 * Guarda el progreso de reproducción de un episodio
 */
async function guardarProgresoReproduccion(animeId, episodioNum, progresoSegundos) {
    if (!currentUser || !animeId || !episodioNum) return;
    
    try {
        await _db.from('progreso_reproduccion').upsert({
            usuario: currentUser,
            anime_id: animeId,
            episodio_num: episodioNum,
            progreso_segundos: progresoSegundos,
            fecha_actualizacion: new Date().toISOString()
        }, { onConflict: 'usuario,anime_id,episodio_num' });
        
        console.log(`✅ Progreso guardado: Ep ${episodioNum} de anime ${animeId} en ${progresoSegundos}s`);
    } catch (err) {
        console.error("Error al guardar progreso:", err);
    }
}

/**
 * Carga el progreso de reproducción de un anime específico
 */
async function cargarProgresoAnime(animeId) {
    if (!currentUser || !animeId) return null;
    
    try {
        const { data, error } = await _db
            .from('progreso_reproduccion')
            .select('*')
            .eq('usuario', currentUser)
            .eq('anime_id', animeId)
            .order('fecha_actualizacion', { ascending: false })
            .limit(1)
            .single();
        
        if (error) throw error;
        return data;
    } catch (err) {
        console.error("Error al cargar progreso:", err);
        return null;
    }
}

/**
 * Carga todos los animes con progreso guardado para la sección "Continuar viendo"
 */
async function cargarContinuarViendo() {
    if (!currentUser) return [];
    
    try {
        const { data, error } = await _db
            .from('progreso_reproduccion')
            .select('*')
            .eq('usuario', currentUser)
            .order('fecha_actualizacion', { ascending: false })
            .limit(10);
        
        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error("Error al cargar continuar viendo:", err);
        return [];
    }
}

/**
 * Renderiza la sección "Continuar Viendo" con los animes con progreso guardado
 */
async function renderContinuarViendo() {
    const seccion = document.getElementById('seccion-continuar-viendo');
    const lista = document.getElementById('lista-continuar-viendo');
    
    if (!seccion || !lista) {
        console.log("❌ [Continuar Viendo] No se encontraron los elementos HTML.");
        return;
    }
    
    console.log("🔄 [Continuar Viendo] Iniciando render...");
    const progresoData = await cargarContinuarViendo();
    
    console.log("📊 [Continuar Viendo] Datos recibidos de la DB:", progresoData);
    
    if (!progresoData || progresoData.length === 0) {
        console.log("⚠️ [Continuar Viendo] Como progresoData está vacío, ocultamos la sección.");
        seccion.style.display = 'none';
        return;
    }
    
    seccion.style.display = 'block';
    lista.innerHTML = '';

    try {
        const ids = progresoData.map(item => parseInt(item.anime_id));
        console.log("🆔 [Continuar Viendo] IDs a consultar a la caché:", ids);

        const metadataMap = await fetchJikanBatchConCache(ids);
        console.log("📦 [Continuar Viendo] Metadata obtenida de la caché:", metadataMap);
        
        let rendersExitosos = 0;

        progresoData.forEach(item => {
            const anime = metadataMap[item.anime_id];
            
            if (!anime) {
                console.warn(`⚠️ [Continuar Viendo] No se encontró metadata para el anime ID: ${item.anime_id}`);
                return; 
            }

            const div = document.createElement('div');
            div.className = 'card';
            div.onclick = () => showDetails(anime);
            
            const minutos = Math.floor(item.progreso_segundos / 60);
            const tiempoTexto = minutos > 0 ? `${minutos} min` : `${item.progreso_segundos}s`;
            
            const imgUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url || 'placeholder.png';
            const titleEs = anime.titles ? anime.titles.find(t => t.type === 'Spanish')?.title : null;
            const nombreMostrar = titleEs || anime.title || "Sin título";

            div.innerHTML = `
                <div class="card-img" style="background-image: url('${imgUrl}');">
                    <div class="progreso-badge" style="position: absolute; bottom: 5px; right: 5px; background: rgba(255,215,0,0.9); color: #000; padding: 3px 8px; border-radius: 5px; font-size: 0.7rem; font-weight: bold;">
                        Ep ${item.episodio_num} • ${tiempoTexto}
                    </div>
                </div>
                <div class="card-info">
                    <h3 class="card-title">${nombreMostrar}</h3>
                </div>
            `;
            
            lista.appendChild(div);
            rendersExitosos++;
        });

        console.log(`✅ [Continuar Viendo] Se renderizaron con éxito ${rendersExitosos} animes.`);

        // Si no logramos renderizar ninguno porque la metadata falló para todos
        if (rendersExitosos === 0) {
            console.log("⚠️ [Continuar Viendo] 0 animes renderizados. Ocultando sección.");
            seccion.style.display = 'none';
        }

    } catch (error) {
        console.error("🚨 [Continuar Viendo] Error crítico durante el renderizado:", error);
        seccion.style.display = 'none';
    }
}

async function showDetails(a) {
    // --- 0. RESET Y LIMPIEZA DEL REPRODUCTOR ---
    const iframePrev = document.querySelector('.video-iframe-aidume') || document.getElementById('video-iframe');
    const videoContainer = document.getElementById('video-player-container');
    const videoInfo = document.getElementById('video-ep-title');

    if (iframePrev) iframePrev.src = ""; 
    if (videoContainer) videoContainer.style.display = "none"; 
    if (videoInfo) videoInfo.innerText = ""; 

    currentAnime = a;

    // 1. Validar datos incompletos
    if (!a.synopsis || a.episodes === undefined || a.episodes === null) {
        document.getElementById('details').style.display = "block";
        document.getElementById('dt-title').innerText = "Cargando...";
        try {
            const res = await fetch(`https://api.jikan.moe/v4/anime/${a.mal_id}`);
            const fullData = await res.json();
            a = fullData.data;
            currentAnime = a; 
        } catch (error) {
            console.error("Error Jikan:", error);
        }
    }

    const titleEs = a.titles ? a.titles.find(t => t.type === 'Spanish')?.title : null;
    const nombreFinal = titleEs || a.title;

    // --- MOSTRAR ID SOLO A DUEÑO/ADMIN ---
    const titleContainer = document.getElementById('dt-title');
    if (titleContainer) {
        const profileData = JSON.parse(localStorage.getItem('aidume_profile'));
        if (profileData && (profileData.rol === 'dueño' || profileData.rol === 'admin' || profileData.rol === 'moderador')) {
            titleContainer.innerHTML = `${nombreFinal} <span style="font-size:0.8rem; color:var(--gold); opacity:0.7; margin-left:10px;">(ID: ${a.mal_id})</span>`;
        } else {
            titleContainer.innerText = nombreFinal;
        }
    }

    document.getElementById('details').style.display = "block";
    document.getElementById('dp-img').style.backgroundImage = `url(${a.images.jpg.large_image_url})`;

    // --- 2. GENERADOR DE EPISODIOS CON LÓGICA DE EXTENSIÓN ---
    const gridEps = document.getElementById('grid-episodios');
    const epBadge = document.getElementById('ep-count-badge');
    
    let totalEps = parseInt(a.episodes) || 0;
    let estaEnEmision = a.status === "Currently Airing";

    if (gridEps) {
        gridEps.innerHTML = "<p style='text-align:center; opacity:0.5; padding:20px;'>Cargando episodios...</p>"; 

        let listaVistos = [];
        try {
            // A. Cargar desde el log JSON en perfiles (1 fila por usuario, no miles)
            if (currentUser) {
                const log = await obtenerLogVistos();
                listaVistos = log[String(a.mal_id)] || [];
                console.log(`📚 Episodios vistos cargados para ${currentUser} (Anime ID ${a.mal_id}):`, listaVistos);
            }

            // B. LÓGICA DE EXTENSIÓN
            const { data: linksExtra } = await _db
                .from('enlaces_episodios')
                .select('episodio_num')
                .eq('anime_id', a.mal_id);
            
            if (linksExtra && linksExtra.length > 0) {
                const maxLinkManual = Math.max(...linksExtra.map(l => l.episodio_num));
                if (maxLinkManual > totalEps) {
                    totalEps = maxLinkManual;
                }
            }
        } catch (err) { console.error("Error en Supabase:", err); }

        const dibujarBotones = (cantidad) => {
    let html = "";
    const nombreLimpio = nombreFinal.replace(/'/g, "\\'").replace(/"/g, '"');
    
    for (let i = 1; i <= cantidad; i++) {
        const isChecked = listaVistos.includes(i) ? 'checked' : '';
        html += `
            <div class="episode-row" data-ep="${i}" tabindex="0" 
                 onkeydown="if(event.key==='Enter'){reproducirEpisodio('${nombreLimpio}', ${i});}">
                <div class="ep-info" onclick="reproducirEpisodio('${nombreLimpio}', ${i})">
                    <span class="play-icon">▶</span>
                    <div>
                        <div class="ep-name">${nombreFinal}</div>
                        <div class="ep-num">Episodio ${i}</div>
                    </div>
                </div>
                
                <div class="ep-check-area" style="display: flex !important; flex-direction: row !important; align-items: center !important; gap: 8px; min-width: 100px; justify-content: flex-end;">
                    
                    <span tabindex="0" onclick="event.stopPropagation(); reportarFalla(${i}, '${nombreLimpio}')" 
                          onkeydown="if(event.key==='Enter'){event.stopPropagation();reportarFalla(${i}, '${nombreLimpio}');}"
                          style="color: #ff4444; font-weight: bold; cursor: pointer; font-size: 1.3rem; padding: 5px; user-select: none;"
                          title="Reportar video caído">
                        !
                    </span>

                    <label class="custom-checkbox" style="margin: 0;">
                        <input type="checkbox" ${isChecked} onchange="toggleEpisodioVisto(${a.mal_id}, ${i}, this)">
                        <span class="checkmark"></span>
                    </label>
                    <span class="check-text" style="margin: 0;">VISTO</span>
                </div>
            </div>`;
    }
    gridEps.innerHTML = html;
    if (epBadge) epBadge.innerText = `${cantidad} disponibles`;

    // En TV, también quitamos el max-height del grid para que no haya scroll anidado
    if (document.documentElement.classList.contains('tv-device')) {
        const grid = document.getElementById('grid-episodios');
        if (grid) {
            grid.style.maxHeight = 'none';
            grid.style.overflow = 'visible';
        }
    }
};

        if (totalEps > 0) {
            dibujarBotones(totalEps);
        } else {
            try {
                const resEp = await fetch(`https://api.jikan.moe/v4/anime/${a.mal_id}/episodes`);
                const dataEp = await resEp.json();
                
                if (dataEp.data && dataEp.data.length > 0) {
                    dibujarBotones(dataEp.data.length);
                } else if (estaEnEmision) {
                    dibujarBotones(1); 
                    if (epBadge) epBadge.innerText = "1 disponible (Emisión)";
                } else {
                    gridEps.innerHTML = "<p style='text-align:center; opacity:0.5; padding:20px;'>Próximamente en AiduMe.</p>";
                    if (epBadge) epBadge.innerText = "0 disponibles";
                }
            } catch (e) {
                gridEps.innerHTML = "<p style='text-align:center; opacity:0.5; padding:20px;'>Lista no disponible</p>";
            }
        }
    }

    // --- 3. TRADUCCIÓN Y CONTROL DE "VER MÁS" ---
    const synopsisElem = document.getElementById('dt-synopsis');
    const btnReadMore = document.getElementById('btn-read-more');

    if (synopsisElem) {
        synopsisElem.classList.remove('expanded');
        synopsisElem.style.maxHeight = "4.5em"; 
        synopsisElem.innerText = "Traduciendo...";
        if (btnReadMore) btnReadMore.style.display = "none";

        const textoParaTraducir = a.synopsis || "No hay descripción disponible.";
        
        try {
            const resTr = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(textoParaTraducir)}`);
            const jsonTr = await resTr.json();
            let textoTraducido = jsonTr[0].map(item => item[0]).join("");
            
            textoTraducido = textoTraducido.replace(/\[Escrito por MAL Rewrite\]/g, "").replace(/\[Written by MAL Rewrite\]/g, "");
            synopsisElem.innerText = textoTraducido.trim();

            setTimeout(() => {
                if (synopsisElem.scrollHeight > synopsisElem.offsetHeight) {
                    if (btnReadMore) {
                        btnReadMore.style.display = "block";
                        btnReadMore.innerText = "Ver más...";
                    }
                }
            }, 150); 
        } catch (e) { 
            synopsisElem.innerText = textoParaTraducir.replace(/\[Written by MAL Rewrite\]/g, ""); 
        }
    }

    // --- 4. VERIFICACIÓN DE ESTRELLAS Y CARGAS ADICIONALES ---
    checkUserRating(a.mal_id); 
    cargarRelaciones(a.mal_id);
    cargarPuntuacionComunidad(a.mal_id);
    updateListButton();      
    cargarComentarios(a.mal_id); 
    saveHistory(a); 
}

async function reportarFalla(numEpisodio, nombreAnime) {
    // 1. Detectar idioma
    const botones = Array.from(document.querySelectorAll('button'));
    const btnLatino = botones.find(b => b.innerText.includes('LATINO'));
    
    const esLatinoActivo = btnLatino && (
        btnLatino.style.background.includes('rgb(255, 193, 7)') || 
        btnLatino.classList.contains('active') ||
        window.getComputedStyle(btnLatino).backgroundColor === 'rgb(255, 193, 7)'
    );

    const idiomaActual = esLatinoActivo ? 'Latino' : 'Subtitulado';

    // Confirmación
    const confirmar = await goldAlert({
        title: "REPORTAR FALLA",
        text: `¿Reportar el episodio ${numEpisodio} (${idiomaActual}) de "${nombreAnime}" como caído?`,
        icon: "🚩",
        showCancel: true,
        confirmText: "SÍ, REPORTAR"
    });

    if (!confirmar) return;

    try {
        // Guardamos todo en la tabla única 'reportes'
        const { error } = await _db
            .from('reportes')
            .insert([{
                tipo: 'episodio',
                usuario_reporta: currentUser,
                anime_id: currentAnime.mal_id,
                anime_nombre: nombreAnime,
                episodio: numEpisodio,
                idioma: idiomaActual,
                motivo: `Episodio ${numEpisodio} (${idiomaActual}) reportado como caído.`,
                fecha: new Date().toISOString()
            }]);

        if (error) throw error;

        goldAlert({
            title: "ENVIADO",
            text: `El reporte del episodio ${numEpisodio} (${idiomaActual}) ha sido enviado. ¡Gracias por ayudar!`,
            icon: "✔️",
            confirmText: "GENIAL"
        });

    } catch (err) {
        console.error("Error al reportar episodio:", err);
        goldAlert({
            title: "ERROR",
            text: "No pudimos enviar el reporte en este momento. Inténtalo más tarde.",
            icon: "❌",
            confirmText: "ENTENDIDO"
        });
    }
}

/** --- SISTEMA DE AMIGOS Y CHAT PRIVADO (JSON en perfil) --- **/

// Claves para el JSON de amistades en perfiles
const AMIGOS_KEY = 'amigos_data';

/**
 * Obtiene los datos de amistad de un usuario desde su perfil
 */
async function obtenerAmigosData(usuario) {
    if (!usuario) return { amigos: [], solicitudes_recibidas: [], solicitudes_enviadas: [] };
    try {
        const { data } = await _db
            .from('perfiles')
            .select(AMIGOS_KEY)
            .ilike('nombre', usuario)
            .single();
        return data?.[AMIGOS_KEY] || { amigos: [], solicitudes_recibidas: [], solicitudes_enviadas: [] };
    } catch {
        return { amigos: [], solicitudes_recibidas: [], solicitudes_enviadas: [] };
    }
}

/**
 * Guarda los datos de amistad en el perfil del usuario
 */
async function guardarAmigosData(usuario, data) {
    if (!usuario) return;
    await _db.from('perfiles').update({ [AMIGOS_KEY]: data }).ilike('nombre', usuario);
}

async function enviarSolicitudAmistad(usuarioDestino) {
    if (!currentUser) return;
    if (currentUser.trim().toLowerCase() === usuarioDestino.trim().toLowerCase()) return;

    try {
        // Obtener datos de ambos usuarios
        const [miData, destData] = await Promise.all([
            obtenerAmigosData(currentUser),
            obtenerAmigosData(usuarioDestino)
        ]);

        // Normalizar nombres
        const yo = currentUser.trim();
        const el = usuarioDestino.trim();

        // Verificar si ya son amigos o ya hay solicitud
        if (miData.amigos.includes(el)) {
            return goldAlert({ title: "YA SON AMIGOS", text: `Ya eres amigo de @${el}.`, icon: "👥" });
        }
        if (miData.solicitudes_enviadas.includes(el)) {
            return goldAlert({ title: "SOLICITUD PENDIENTE", text: `Ya enviaste una solicitud a @${el}.`, icon: "📨" });
        }
        if (miData.solicitudes_recibidas.includes(el)) {
            // Si él ya me envió solicitud, la aceptamos automáticamente
            return aceptarSolicitudAmistad(el);
        }

        // Agregar solicitud enviada a mi perfil
        miData.solicitudes_enviadas.push(el);
        await guardarAmigosData(currentUser, miData);

        // Agregar solicitud recibida al perfil del destino
        destData.solicitudes_recibidas.push(yo);
        await guardarAmigosData(usuarioDestino, destData);

        goldAlert({ title: "SOLICITUD ENVIADA", text: `Has invitado a @${el} a ser tu amigo.`, icon: "✨" });
        actualizarPerfilDesdeSQL(usuarioDestino);
    } catch (err) {
        console.error("Error al enviar solicitud:", err);
        goldAlert({ title: "ERROR", text: "No se pudo enviar la solicitud.", icon: "❌" });
    }
}

/**
 * Acepta una solicitud de amistad
 */
async function aceptarSolicitudAmistad(usuarioOrigen) {
    if (!currentUser) return;
    try {
        const [miData, suData] = await Promise.all([
            obtenerAmigosData(currentUser),
            obtenerAmigosData(usuarioOrigen)
        ]);

        const yo = currentUser.trim();
        const el = usuarioOrigen.trim();

        // Quitar de solicitudes_recibidas mías y solicitudes_enviadas de él
        miData.solicitudes_recibidas = miData.solicitudes_recibidas.filter(u => u !== el);
        suData.solicitudes_enviadas = suData.solicitudes_enviadas.filter(u => u !== yo);

        // Agregar a amigos de ambos
        if (!miData.amigos.includes(el)) miData.amigos.push(el);
        if (!suData.amigos.includes(yo)) suData.amigos.push(yo);

        await Promise.all([
            guardarAmigosData(currentUser, miData),
            guardarAmigosData(usuarioOrigen, suData)
        ]);

        goldAlert({ title: "AMIGOS", text: `Ahora tú y @${el} son amigos.`, icon: "🤝" });
        actualizarPerfilDesdeSQL();
    } catch (err) {
        console.error("Error al aceptar solicitud:", err);
    }
}

/**
 * Rechaza una solicitud de amistad
 */
async function rechazarSolicitudAmistad(usuarioOrigen) {
    if (!currentUser) return;
    try {
        const [miData, suData] = await Promise.all([
            obtenerAmigosData(currentUser),
            obtenerAmigosData(usuarioOrigen)
        ]);

        const yo = currentUser.trim();
        const el = usuarioOrigen.trim();

        miData.solicitudes_recibidas = miData.solicitudes_recibidas.filter(u => u !== el);
        suData.solicitudes_enviadas = suData.solicitudes_enviadas.filter(u => u !== yo);

        await Promise.all([
            guardarAmigosData(currentUser, miData),
            guardarAmigosData(usuarioOrigen, suData)
        ]);

        goldAlert({ title: "RECHAZADA", text: `Has rechazado la solicitud de @${el}.`, icon: "❌" });
        actualizarPerfilDesdeSQL();
    } catch (err) {
        console.error("Error al rechazar solicitud:", err);
    }
}

/**
 * Escucha en tiempo real si alguien envía una solicitud al usuario actual
 * (Polling cada 15 segundos ya que no tenemos tabla para Realtime)
 */
function escucharSolicitudesAmistad() {
    if (!currentUser) return;
    
    let ultimasSolicitudes = [];
    
    setInterval(async () => {
        if (!currentUser) return;
        const miData = await obtenerAmigosData(currentUser);
        const nuevas = miData.solicitudes_recibidas.filter(s => !ultimasSolicitudes.includes(s));
        
        if (nuevas.length > 0) {
            ultimasSolicitudes = [...miData.solicitudes_recibidas];
            
            for (const solicitante of nuevas) {
                reproducirSonidoAnime();
                
                const seccionAmigos = document.getElementById('seccion-amigos-perfil');
                if (seccionAmigos && seccionAmigos.style.display !== 'none') {
                    actualizarPerfilDesdeSQL();
                }

                const respuesta = await goldAlert({
                    title: "NUEVA SOLICITUD",
                    text: `@${solicitante} quiere ser tu amigo.`,
                    icon: "👥",
                    showCancel: true,
                    confirmText: "ACEPTAR"
                });

                if (respuesta) {
                    await aceptarSolicitudAmistad(solicitante);
                } else {
                    await rechazarSolicitudAmistad(solicitante);
                }
            }
        }
        
        // Actualizar lista de solicitudes conocidas
        ultimasSolicitudes = [...miData.solicitudes_recibidas];
    }, 15000);
}

/**
 * Permite al dueño forzar una actualización de la aplicación para todos los usuarios.
 * Esto se logra actualizando un valor en Supabase que los clientes verifican.
 */
async function triggerAppUpdate() {
    const confirmar = await goldAlert({
        title: "FORZAR ACTUALIZACIÓN",
        text: "¿Estás seguro de que quieres forzar una actualización para TODOS los usuarios? Esto recargará la aplicación de todos.",
        icon: "🚀",
        showCancel: true,
        confirmText: "SÍ, ACTUALIZAR AHORA"
    });

    if (!confirmar) return;

    try {
        const newVersionTimestamp = new Date().toISOString();
        await _db.from('app_settings').upsert({
            key: 'app_version',
            value: newVersionTimestamp
        }, { onConflict: 'key' });

        goldAlert({ title: "ACTUALIZACIÓN ENVIADA", text: "La señal de actualización ha sido enviada. Los usuarios recargarán la app.", icon: "✔️" });
    } catch (err) {
        console.error("Error al forzar actualización:", err);
        goldAlert({ title: "ERROR", text: "No se pudo enviar la señal de actualización.", icon: "❌" });
    }
}

/**
 * Verifica periódicamente si hay actualizaciones disponibles en Supabase
 * y recarga la aplicación si detecta un cambio de versión
 */
async function checkForAppUpdate() {
    try {
        const { data, error } = await _db
            .from('app_settings')
            .select('value')
            .eq('key', 'app_version')
            .single();
        
        if (error) throw error;
        
        const remoteVersion = data?.value;
        const localVersion = localStorage.getItem('aidume_app_version');
        
        // Si no hay versión local, guardar la actual
        if (!localVersion && remoteVersion) {
            localStorage.setItem('aidume_app_version', remoteVersion);
            return;
        }
        
        // Si las versiones son diferentes, recargar la app
        if (remoteVersion && localVersion && remoteVersion !== localVersion) {
            console.log('🚀 Nueva versión detectada, recargando aplicación...');
            localStorage.setItem('aidume_app_version', remoteVersion);
            
            // Mostrar alerta antes de recargar
            await goldAlert({
                title: "ACTUALIZACIÓN DISPONIBLE",
                text: "Hay una nueva versión de AiduMe. La aplicación se recargará automáticamente.",
                icon: "🔄",
                confirmText: "ENTENDIDO"
            });
            
            location.reload();
        }
    } catch (err) {
        console.error("Error al verificar actualizaciones:", err);
    }
}

/**
 * SISTEMA DE TRANSMISIÓN A SMART TV / ANDROID TV / TV BOX
 * Soporta: Chromecast (WebCast), AirPlay, DLNA, y modo ventana emergente
 */

// Variable para controlar el estado de casting
let castSession = null;
let castInterval = null;

async function transmitirTV() {
    if (!urlTransmisionActual) return;

    const opciones = await goldAlert({
        title: "📺 TRANSMITIR A TV",
        text: "¿Cómo quieres ver el contenido en tu TV?\n\n🏠 Misma red WiFi recomendado.",
        icon: "📡",
        showCancel: true,
        confirmText: "SELECCIONAR MÉTODO",
        showInput: false
    });

    if (!opciones) return;

    // Mostramos el selector de métodos
    const metodo = await goldAlert({
        title: "🎯 SELECCIONA MÉTODO",
        text: "1️⃣ Chromecast / Google Cast\n2️⃣ Android TV (Código PIN)\n3️⃣ Ventana Emergente\n4️⃣ Abrir en navegador TV",
        icon: "📺",
        showCancel: true,
        confirmText: "SELECCIONAR",
        showInput: true,
        inputPlaceholder: "Número (1, 2, 3 o 4)"
    });

    if (!metodo) return;

    switch(metodo.trim()) {
        case '1':
            await iniciarChromecast(urlTransmisionActual);
            break;
        case '2':
            await iniciarCastPin(urlTransmisionActual);
            break;
        case '3':
            abrirVentanaEmergente(urlTransmisionActual);
            break;
        case '4':
            abrirEnTV(urlTransmisionActual);
            break;
        default:
            goldAlert({ title: "OPCIÓN INVÁLIDA", text: "Elige 1, 2, 3 o 4.", icon: "❌" });
    }
}

/**
 * 1️⃣ CHROMECAST / GOOGLE CAST (WebCast)
 * Usa la API nativa de Google Cast si está disponible
 */
async function iniciarChromecast(url) {
    // Detectamos si el navegador soporta Casting nativo
    const tieneCastNatvo = !!window.chrome && !!chrome.cast;
    const tieneMediaSession = 'mediaSession' in navigator;
    const esAndroid = /Android/i.test(navigator.userAgent);

    if (tieneCastNatvo) {
        try {
            // Intentamos usar la API de Google Cast
            const session = await chrome.cast.requestSession();
            const mediaInfo = new chrome.cast.media.MediaInfo(url, 'text/html');
            const request = new chrome.cast.media.LoadRequest(mediaInfo);
            await session.loadMedia(request);
            castSession = session;
            
            goldAlert({ title: "📡 CAST INICIADO", text: "Buscando en tu TV...\nVerifica que esté encendida.", icon: "✨" });
            return;
        } catch (e) {
            console.warn("Cast nativo falló, usando alternativas:", e);
        }
    }

    // Alternativa: Usar el menú de Cast del navegador (Chrome/Edge)
    if (esAndroid) {
        // En Android, usamos la API de MediaSession para habilitar el botón de Cast
        try {
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: currentAnime?.title || "AiduMe",
                    artist: "AiduMe Gold",
                    artwork: [{ src: currentAnime?.images?.jpg?.image_url || 'logo-grande.png', sizes: '512x512', type: 'image/png' }]
                });
                navigator.mediaSession.setActionHandler('seekforward', () => {});
                navigator.mediaSession.setActionHandler('seekbackward', () => {});
            }
            
            // Mostramos instrucciones para Android TV
            await goldAlert({
                title: "📱 ANDROID TV",
                text: "1. Abre el video actual\n2. Toca el icono de 📺 o 🖥️ en los controles del video\n3. Selecciona tu TV\n\nO usa el menú de Cast de Chrome (tres puntos ⋮ > Transmitir...).",
                icon: "📺",
                confirmText: "ENTENDIDO"
            });
            
            // Abrimos el video en pantalla completa para que aparezca el botón Cast
            const container = document.getElementById('video-player-container');
            const iframe = container?.querySelector('iframe');
            if (iframe && container?.style.display !== 'none') {
                maximizarVideoAidume(container);
            }
            return;
        } catch (e) {
            console.warn("Error en MediaSession:", e);
        }
    }

    // Fallback: Instrucciones manuales
    abrirVentanaEmergente(url);
}

/**
 * 2️⃣ ANDROID TV / TV BOX: Transmisión por código QR + PIN
 * Genera un código que el usuario ingresa en la TV
 */
async function iniciarCastPin(url) {
    // Generamos un código temporal para la sesión
    const sessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    // Guardamos la sesión en Supabase (o localStorage como fallback)
    const sessionData = {
        url: url,
        anime: currentAnime?.title || "Anime",
        episodio: ultimoEpisodioCargado?.num || 1,
        timestamp: Date.now()
    };

    try {
        await _db.from('tv_cast_sessions').insert([{
            session_id: sessionId,
            usuario: currentUser,
            data: sessionData,
            expira: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        }]);
    } catch (e) {
        // Fallback: guardamos en localStorage por si no hay tabla
        localStorage.setItem('aidume_cast_session_' + sessionId, JSON.stringify(sessionData));
        console.warn("Usando localStorage para cast session:", e);
    }

    await goldAlert({
        title: "📡 CÓDIGO DE TRANSMISIÓN",
        text: `Ve a tu Android TV / TV Box y abre AiduMe.\n\nEn la TV, selecciona "📡 Recibir" e ingresa este código:\n\n🔑 ${sessionId}\n\n⏳ El código expira en 5 minutos.\n\nAsegúrate de que ambos dispositivos estén en la MISMA RED WiFi.`,
        icon: "📺",
        confirmText: "¡LISTO!"
    });

    // Esperamos que la TV reclame la sesión (polling cada 3 segundos)
    let intentos = 0;
    const maxIntentos = 100; // ~5 minutos
    
    castInterval = setInterval(async () => {
        intentos++;
        
        if (intentos > maxIntentos) {
            clearInterval(castInterval);
            goldAlert({ title: "⏰ EXPIRADO", text: "El código de transmisión ha expirado. Genera uno nuevo.", icon: "⏳" });
            return;
        }

        try {
            const { data } = await _db.from('tv_cast_sessions')
                .select('reclamado')
                .eq('session_id', sessionId)
                .single();
            
            if (data?.reclamado) {
                clearInterval(castInterval);
                goldAlert({ title: "📡 TV CONECTADA", text: "Tu TV ha tomado el control de la reproducción.", icon: "✅" });
            }
        } catch (e) {
            // Tabla no existe o error, detenemos polling
            clearInterval(castInterval);
        }
    }, 3000);
}

/**
 * 3️⃣ VENTANA EMERGENTE (Pop-up con el video)
 */
function abrirVentanaEmergente(url) {
    const w = window.open(url, '_blank', 'width=800,height=600,scrollbars=yes');
    if (!w || w.closed) {
        goldAlert({
            title: "🚫 BLOQUEADO",
            text: "El navegador bloqueó la ventana.\n\n👉 Permite las ventanas emergentes para este sitio.\n\nO usa la opción 4 'Abrir en navegador TV'.",
            icon: "⚠️",
            confirmText: "ENTENDIDO"
        });
    } else {
        goldAlert({ title: "✅ LISTO", text: "El video se abrirá en una nueva ventana. Puedes arrastrarla a tu TV si usas pantalla extendida.", icon: "📺" });
    }
}

/**
 * 4️⃣ ABRIR EN NAVEGADOR TV (Copia manual de URL)
 */
async function abrirEnTV(url) {
    const confirmar = await goldAlert({
        title: "📋 ENLACE PARA TV",
        text: `Copia este enlace y pégalo en el navegador de tu Smart TV / TV Box / Consola:\n\n${url}\n\n¿Quieres acortar la URL?`,
        icon: "🔗",
        showCancel: true,
        confirmText: "SÍ, AYUDA"
    });

    if (confirmar) {
        try {
            // Intenta copiar al portapapeles automáticamente
            await navigator.clipboard.writeText(url);
            goldAlert({
                title: "📋 COPIADO",
                text: "El enlace se copió a tu portapapeles. Pégalo en el navegador de tu TV.",
                icon: "✅"
            });
        } catch (e) {
            goldAlert({
                title: "📄 MANUAL",
                text: `Ve al navegador de tu TV y escribe:\n\n${url}`,
                icon: "📺"
            });
        }
    } else {
        goldAlert({
            title: "📄 MANUAL",
            text: `Ve al navegador de tu TV y escribe:\n\n${url}`,
            icon: "📺"
        });
    }
}

async function cargarChatPrivado(amigo) {
    chatAmigoActual = amigo;
    if (!currentUser || !amigo) return;

    document.getElementById('privado-titulo').innerText = `💬 @${amigo}`;
    document.getElementById('modal-chat-privado').style.display = 'flex';
    
    const u1 = String(currentUser).trim();
    const u2 = String(amigo).trim();

    // --- MARCAR COMO LEÍDOS AL ABRIR ---
    await _db.from('chat_privado')
        .update({ leido: true })
        .eq('emisor', u2)
        .eq('receptor', u1)
        .eq('leido', false);

    // Si el perfil está abierto, refrescamos para que el badge de este amigo desaparezca
    const seccionAmigos = document.getElementById('seccion-amigos-perfil');
    if (seccionAmigos && seccionAmigos.style.display !== 'none') {
        actualizarPerfilDesdeSQL();
    }
    actualizarNotificacionesPerfil();

    // Cargar mensajes previos
    const { data } = await _db.from('chat_privado')
        .select('*')
        .or(`and(emisor.ilike."${u1}",receptor.ilike."${u2}"),and(emisor.ilike."${u2}",receptor.ilike."${u1}")`)
        .order('fecha', { ascending: true });

    renderizarMensajesPrivados(data || []);
    escucharChatPrivado();
}

function renderizarMensajesPrivados(mensajes) {
    const cont = document.getElementById('privado-mensajes');
    cont.innerHTML = mensajes.map(m => {
        const esMio = String(m.emisor).trim().toLowerCase() === String(currentUser).trim().toLowerCase();
        const textoLimpio = parsearMensajeParaStickers(m.mensaje);
        
        // Icono de visto solo para mis mensajes (siempre se muestra)
        const checkIcon = esMio
            ? `<img src="stickers/${m.leido ? 'visto2.png' : 'visto.png'}" class="chat-seen-icon ${m.leido ? 'seen' : 'unseen'}">`
            : '';

        return `
            <div class="priv-msg-row ${esMio ? 'priv-msg-me' : 'priv-msg-them'}">
                ${textoLimpio} ${checkIcon}
            </div>`;
    }).join('');
    cont.scrollTop = cont.scrollHeight;
}

async function enviarMensajePrivado() {
    const input = document.getElementById('privado-input');
    const texto = input.value.trim();
    if (!texto || !chatAmigoActual || !currentUser) return;

    const { error } = await _db.from('chat_privado').insert([
        { emisor: String(currentUser).trim(), receptor: String(chatAmigoActual).trim(), mensaje: texto }
    ]);

    if (!error) {
        input.value = "";
        reproducirSonidoChat();
    } else {
        console.error("🚨 Error Supabase:", error.code, error.message);
        const msgError = error.code === '42501' 
            ? "Error de permisos (RLS). Revisa las políticas en el dashboard de Supabase." 
            : "No pudimos enviar el mensaje. Revisa tu conexión.";
        goldAlert({ title: "ERROR", text: msgError, icon: "❌" });
    }
}

function escucharChatPrivado() {
    const uActual = String(currentUser).trim();

    // Si ya hay una suscripción, la removemos para evitar duplicados
    if (privateChatSubscription) {
        _db.removeChannel(privateChatSubscription);
        privateChatSubscription = null;
        console.log("📡 Desuscrito del canal privado anterior.");
    }

    privateChatSubscription = _db.channel('canal-privado-global')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_privado' }, async (payload) => {
        const m = payload.new;
        const receptor = String(m.receptor).trim();
        const emisor = String(m.emisor).trim();
        const amigo = String(chatAmigoActual).trim();

        console.log("📡 Evento de chat privado recibido:", payload.eventType, m);

        // 1. LÓGICA DE NUEVO MENSAJE (INSERT)
        if (payload.eventType === 'INSERT') {
            if ((emisor === uActual && receptor === amigo) || (emisor === amigo && receptor === uActual)) {
                
                // Si yo soy el receptor y tengo el chat abierto, marcar como leído inmediatamente
                if (receptor === uActual && document.getElementById('modal-chat-privado').style.display === 'flex') {
                    console.log("✔️ Marcando mensaje como leído:", m.id);
                    await _db.from('chat_privado').update({ leido: true }).eq('id', m.id);
                }

                // Vibrar si el mensaje es para mí y el chat NO está abierto
                if (receptor === uActual && document.getElementById('modal-chat-privado').style.display !== 'flex' && navigator.vibrate) {
                    console.log("📳 Vibrando por nuevo mensaje.");
                    navigator.vibrate(200); 
                    reproducirSonidoChat();

                    // Si el perfil está abierto, refrescamos para mostrar el badge de no leídos en tiempo real
                    const seccionAmigos = document.getElementById('seccion-amigos-perfil');
                    if (seccionAmigos && seccionAmigos.style.display !== 'none') {
                        actualizarPerfilDesdeSQL();
                    }
                }

                // OPTIMIZACIÓN: En lugar de re-consultar toda la DB, solo agregamos el mensaje si el chat está abierto
                if (document.getElementById('modal-chat-privado').style.display === 'flex') {
                    const cont = document.getElementById('privado-mensajes');
                    const esMio = emisor === uActual;
                    const checkIcon = esMio ? `<img src="stickers/${m.leido ? 'visto2.png' : 'visto.png'}" class="chat-seen-icon ${m.leido ? 'seen' : 'unseen'}">` : '';
                    cont.innerHTML += `<div class="priv-msg-row ${esMio ? 'priv-msg-me' : 'priv-msg-them'}">${parsearMensajeParaStickers(m.mensaje)} ${checkIcon}</div>`;
                    cont.scrollTop = cont.scrollHeight;
                }
            }
        } 
        
        // 2. LÓGICA DE ACTUALIZACIÓN (UPDATE) -> Para el "Visto" en tiempo real
        // Solo actualizamos si el mensaje que cambió a leído es MÍO y el receptor es mi amigo actual
        if (payload.eventType === 'UPDATE' && emisor === uActual && receptor === amigo && m.leido === true) {
            console.log("👁️ Mensaje mío marcado como visto:", m.id);
            // Si mi mensaje cambió a leído, actualizamos la vista para ver el check azul
            const { data } = await _db.from('chat_privado').select('*')
                .or(`and(emisor.eq."${uActual}",receptor.eq."${amigo}"),and(emisor.eq."${amigo}",receptor.eq."${uActual}")`) // Aseguramos comillas
                .order('fecha', { ascending: true });
            renderizarMensajesPrivados(data || []);
        }
    }).subscribe();
}

function cerrarChatPrivado() {
    document.getElementById('modal-chat-privado').style.display = 'none';
    chatAmigoActual = null;
    // Desuscribirse del canal privado al cerrar el chat
    if (privateChatSubscription) {
        _db.removeChannel(privateChatSubscription);
        privateChatSubscription = null;
        console.log("📡 Desuscrito del canal privado.");
    }
}

/**
 * Actualiza el "latido" del usuario para el estado Online
 */
async function actualizarEstadoConexion() {
    if (!currentUser) return;
    const { error } = await _db.from('perfiles')
        .update({ 
            ultima_conexion: new Date().toISOString(),
            online: true 
        }) 
        .ilike('nombre', currentUser.trim())
        .select(); // Forzamos a que devuelva datos para confirmar el cambio

    if (error) console.error("🚨 Error de Latido (Online):", error.code, error.message);
    else {
        console.log("🟢 Latido (Heartbeat) enviado para:", currentUser);
    }
}

async function renderizarSeccionAmigos(perfil, esMismoUsuario) {
    const seccion = document.getElementById('seccion-amigos-perfil');
    const grid = document.getElementById('lista-amigos-u');
    if (!seccion || !grid) return;

    if (esMismoUsuario) {
        seccion.style.display = 'block';
        const myUser = currentUser.trim();
        const miData = await obtenerAmigosData(myUser);

        const solicitudes = miData.solicitudes_recibidas || [];
        const nombresAmigos = miData.amigos || [];

        console.log("👥 Solicitudes pendientes:", solicitudes);

        let html = "";
        if (solicitudes.length > 0) {
            html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold;">SOLICITUDES PENDIENTES:</p>`;
            solicitudes.forEach(s => {
                html += `
                <div class="friend-item">
                    <span style="font-size:0.8rem;">@${s}</span>
                    <div style="display:flex; gap:5px;">
                        <button onclick="aceptarSolicitudAmistad('${s}')" class="btn-random-gold" style="padding:4px 8px; margin:0;">✔️</button>
                        <button onclick="rechazarSolicitudAmistad('${s}')" class="btn-random-gold" style="padding:4px 8px; margin:0; border-color:red; color:red;">❌</button>
                    </div>
                </div>`;
            });
        }
        
        // --- MEJORA: CONTADOR DE MENSAJES NO LEÍDOS ---
        const { data: noLeidosData } = await _db.from('chat_privado')
            .select('emisor')
            .ilike('receptor', myUser)
            .eq('leido', false);
        
        const conteoNoLeidos = (noLeidosData || []).reduce((acc, m) => {
            const emisorNorm = String(m.emisor).trim().toLowerCase();
            acc[emisorNorm] = (acc[emisorNorm] || 0) + 1;
            return acc;
        }, {});

        // Traer estados de conexión de los amigos
        let estados = [];
        if (nombresAmigos.length > 0) {
            // MEJORA: Nombres entre comillas para evitar errores de sintaxis en el OR
            const orClause = nombresAmigos.map(n => `nombre.ilike."${n.trim()}"`).join(',');
            
            const { data, error } = await _db.from('perfiles')
                .select('nombre, online, ultima_conexion')
                .or(orClause);
            
            if (error) {
                console.error("Error cargando estados de amigos:", error);
                // Respaldo por si el OR es muy largo
                const resFallback = await _db.from('perfiles').select('nombre, ultima_conexion').in('nombre', nombresAmigos);
                estados = resFallback.data || [];
            } else {
                estados = data || [];
            }
        }

        console.log("🌐 Estados de conexión de amigos:", estados);
        if (nombresAmigos.length > 0) {
            html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold; margin-top:10px;">MIS AMIGOS:</p>`;
            nombresAmigos.forEach(amigo => {
                const dataEst = estados?.find(e => e.nombre.toLowerCase() === amigo.toLowerCase());
                
                let esOnline = false;
                let etiquetaTiempo = "Offline";

                if (dataEst && dataEst.ultima_conexion) {
                    // --- PARSEO ROBUSTO DE FECHA (Sincronizado con lógica de chat) ---
                    let isoStr = dataEst.ultima_conexion.trim().replace(" ", "T");
                    if (!isoStr.endsWith('Z') && !isoStr.includes('+') && !isoStr.includes('-')) {
                        isoStr += 'Z';
                    }
                    
                    const fechaObj = new Date(isoStr);

                    // Si la fecha es inválida (ej. si la DB aún devuelve solo '2026-05-01'),
                    // entonces fechaObj.getTime() será NaN. Añadimos un log para depuración.
                    if (isNaN(fechaObj.getTime())) {
                        console.warn(`DEBUG AMIGOS: Fecha de última conexión inválida para ${amigo}: ${dataEst.ultima_conexion}`);
                        return; // Salimos si la fecha no es válida
                    }

                    const ultimaConexion = fechaObj.getTime();
                    const ahora = Date.now();
                    
                    const diferenciaMs = Math.abs(ahora - ultimaConexion);
                    
                    console.log(`DEBUG AMIGOS: Usuario: ${amigo}`);
                    console.log(`DEBUG AMIGOS: ultima_conexion (DB): ${dataEst.ultima_conexion}`);
                    console.log(`DEBUG AMIGOS: fechaObj (parsed): ${fechaObj.toISOString()}`);
                    console.log(`DEBUG AMIGOS: ahora (ms): ${ahora}`);
                    console.log(`DEBUG AMIGOS: ultimaConexion (ms): ${ultimaConexion}`);
                    console.log(`DEBUG AMIGOS: diferenciaMs: ${diferenciaMs} ms (${(diferenciaMs / 60000).toFixed(2)} min)`);
                    
                    // --- DOBLE CHECK: Flag Online Y latido reciente ---
                    // Ajustado a 5 minutos (300,000 ms) para máxima precisión.
                    // Si no hay actividad en 5 min, se considera Offline.
                    esOnline = (dataEst.online === true && diferenciaMs < 300000);

                    console.log(`DEBUG AMIGOS: dataEst.online: ${dataEst.online}`);
                    console.log(`DEBUG AMIGOS: esOnline (calculated): ${esOnline}`);

                    if (esOnline) {
                        etiquetaTiempo = "Online";
                    } else {
                        // Calculamos el tiempo relativo real
                        const diffMins = Math.floor(diferenciaMs / 60000);
                        if (diffMins < 60) etiquetaTiempo = `Hace ${diffMins} min`;
                        else if (diffMins < 1440) etiquetaTiempo = `Hace ${Math.floor(diffMins / 60)}h`;
                        else etiquetaTiempo = `Hace ${Math.floor(diffMins / 1440)} días`;
                    }
                }

                // --- MEJORA: Solo mostrar contador de mensajes si el amigo está Online ---
                const numNoLeidosRaw = conteoNoLeidos[amigo.toLowerCase()] || 0;
                const numNoLeidos = esOnline ? numNoLeidosRaw : 0;
                const badgeNoLeidos = numNoLeidos > 0 ? `<span style="background:#ff4444; color:white; border-radius:50%; padding:2px 7px; font-size:0.65rem; font-weight:bold; margin-left:8px; box-shadow: 0 0 5px rgba(255,0,0,0.5);">${numNoLeidos}</span>` : '';
                
                html += `
                <div class="friend-item">
                    <div onclick="verPerfilAjeno('${amigo}')" style="cursor:pointer; font-size:0.8rem; display:flex; align-items:center;">
                        <span class="${esOnline ? 'online-dot' : 'offline-dot'}"></span>
                        @${amigo} 
                        ${badgeNoLeidos}
                        <small style="font-size:0.6rem; opacity:0.5; margin-left:5px;">(${etiquetaTiempo})</small>
                    </div>
                    <div style="display:flex; gap:4px;">
                        <button onclick="cargarChatPrivado('${amigo}')" class="btn-random-gold" style="padding:4px 8px; margin:0; font-size:0.6rem;">💬</button>
                        <button onclick="invitarAVer('${amigo}')" class="btn-random-gold wp-invite-btn" style="padding:4px 8px; margin:0; font-size:0.6rem;">🎬</button>
                    </div>
                </div>`;
            });
        } else if (solicitudes?.length === 0) {
            html = "<p style='text-align:center; opacity:0.5; font-size:0.8rem;'>Aún no tienes amigos agregados.</p>";
        }
        grid.innerHTML = html;
    } else {
        seccion.style.display = 'none';
    }
}





// FUNCIÓN AUXILIAR PARA EL CHECKBOX (Agrégala también en api.js)
/**
 * Guarda el anime en la lista de "Vistos recientemente" del historial.
 */
async function saveHistory(a) {
    if (!currentUser) return;
    try {
        await _db.from('vistos').upsert({
            usuario_nombre: currentUser,
            anime_id: a.mal_id,
            titulo: a.title,
            imagen_url: a.images.jpg.image_url,
            fecha_visto: new Date().toISOString()
        }, { onConflict: 'usuario_nombre, anime_id' }); // Considera que en la DB el constraint debe ser case-insensitive si es posible
    } catch (err) {
        console.error("❌ Error al guardar historial reciente:", err);
    }
}

// --- SISTEMA DE RECOMPENSAS GOLD (GLOBAL) ---
async function ganarRecompensaGold({ xp = 0, fichas = 0, silencioso = true }) {
    if (!currentUser) return;
    try {
        const { data: perfil, error } = await _db
            .from('perfiles')
            .select('xp, nivel, aidufichas')
            .ilike('nombre', currentUser)
            .single();

        if (error) throw error;

        let nuevaXP = (perfil.xp || 0) + xp;
        let nuevoNivel = perfil.nivel || 1;
        let nuevasFichas = (perfil.aidufichas || 0) + fichas;

        // Multiplicador de XP: Ahora la XP necesaria escala con el nivel (Nivel actual * 3)
        while (nuevaXP >= (nuevoNivel * 3)) {
            nuevaXP -= (nuevoNivel * 3);
            nuevoNivel++;
            if (!silencioso) {
                // Si la función existe, lanzamos la fiesta
                if (typeof lanzarConfetiGold === 'function') lanzarConfetiGold();
                goldAlert({ title: "¡NIVEL ALCANZADO!", text: `Has subido al Nivel ${nuevoNivel}. ¡Tu rango aumenta!`, icon: "🆙" });
            }
        }

        await _db.from('perfiles').update({ 
            xp: nuevaXP, 
            nivel: nuevoNivel, 
            aidufichas: nuevasFichas 
        }).ilike('nombre', currentUser);

        if (typeof actualizarPerfilDesdeSQL === 'function') actualizarPerfilDesdeSQL();
    } catch (err) {
        console.error("Error al procesar recompensa:", err);
    }
}

function iniciarContadorOnline() {
    // Cada 1 hora (3600000 ms) otorga 1 XP y 10 Aidufichas
    setInterval(() => {
        if (currentUser) {
            ganarRecompensaGold({ xp: 0, fichas: 10, silencioso: true });
            console.log("💎 Recompensa por fidelidad otorgada: 10 Aidufichas");
        }
    }, 3600000);
}

/**
 * Gestiona el guardado real en la base de datos y otorga premios.
 */
// --- LOG DE VISTOS EN PERFIL (JSON comprimido, 1 fila por usuario) ---
// En vez de crear una fila en episodios_vistos por cada click,
// guardamos un objeto JSON en el perfil: { "animeId": [ep1, ep2, ep3] }
// Esto reduce enormemente la cantidad de filas en la DB.
const LOG_VISTOS_KEY = 'log_vistos'; // columna en perfiles que almacena el JSON

/**
 * Obtiene el log de vistos del usuario actual desde su perfil
 */
async function obtenerLogVistos() {
    if (!currentUser) return {};
    try {
        const { data } = await _db
            .from('perfiles')
            .select(LOG_VISTOS_KEY)
            .ilike('nombre', currentUser)
            .single();
        return data?.[LOG_VISTOS_KEY] || {};
    } catch {
        return {};
    }
}

/**
 * Guarda el log de vistos en el perfil del usuario (1 sola actualización)
 */
async function guardarLogVistos(log) {
    if (!currentUser) return;
    await _db.from('perfiles').update({ [LOG_VISTOS_KEY]: log }).ilike('nombre', currentUser);
}

async function toggleEpisodioVisto(animeId, epNum, checkbox) {
    if (!currentUser) return goldAlert({ text: "Inicia sesión para guardar tu progreso", icon: "👤" });

    try {
        const log = await obtenerLogVistos();
        const animeKey = String(animeId);
        
        // Asegurar que sea un array
        if (!log[animeKey]) log[animeKey] = [];

        if (checkbox.checked) {
            // Solo agregar si no estaba ya (evita duplicados)
            if (!log[animeKey].includes(epNum)) {
                log[animeKey].push(epNum);
                
                // --- RECOMPENSA ÚNICA (solo primera vez que ve este episodio) ---
                await ganarRecompensaGold({ xp: 1, fichas: 2, silencioso: false });
                console.log(`💰 XP y Fichas otorgadas por Ep ${epNum} de Anime ${animeId}`);
            }
        } else {
            // Quitar episodio del array
            log[animeKey] = log[animeKey].filter(e => e !== epNum);
            // Si el array queda vacío, borramos la clave para ahorrar espacio
            if (log[animeKey].length === 0) delete log[animeKey];
        }

        // Guardar todo el log de una sola vez (1 UPDATE en perfiles)
        await guardarLogVistos(log);
        console.log(`✅ Log de vistos actualizado: Anime ${animeId}, Ep ${epNum}`);

        // Refrescar UI
        if (typeof actualizarPerfilDesdeSQL === 'function') {
            actualizarPerfilDesdeSQL(usuarioEnPantalla || currentUser);
        }

    } catch (err) {
        console.error("🚨 Error en toggleEpisodioVisto:", err);
        goldAlert({ title: "ERROR", text: "No se pudo sincronizar el progreso.", icon: "❌" });
    }
}

// [IMPORTANTE: BORRA LA FUNCIÓN saveHistory QUE ESTABA AL FINAL DE TU ARCHIVO VIEJO]

async function updateListButton() {
    const b = document.getElementById('btn-toggle-list');
    if (!currentAnime || !currentUser) return;

    // Buscamos en la nube si ya es favorito
    const { data: existe } = await _db
        .from('favoritos')
        .select('*')
        .ilike('usuario_nombre', currentUser)
        .eq('anime_id', currentAnime.mal_id)
        .maybeSingle();

    if (existe) {
        b.innerHTML = "➖ Quitar de la Lista";
        b.classList.add('in-list'); 
        b.onclick = async () => {
            await _db.from('favoritos').delete()
                .ilike('usuario_nombre', currentUser)
                .eq('anime_id', currentAnime.mal_id);
            updateListButton(); 
        };
    } else {
        b.innerHTML = "➕ Añadir a Mi Lista";
        b.classList.remove('in-list');
        b.onclick = async () => {
            await _db.from('favoritos').insert([{
                usuario_nombre: currentUser,
                anime_id: currentAnime.mal_id,
                titulo: currentAnime.title,
                imagen_url: currentAnime.images.jpg.image_url
            }]);
            updateListButton(); 
        };
    }
}

async function rateAnime(stars) {
    if (!currentAnime || !currentUser) return;

    try {
        // 1. Verificamos si ya votó antes de intentar insertar
        const { data: yaVoto } = await _db
            .from('valoraciones')
            .select('estrellas')
            .ilike('usuario_nombre', currentUser)
            .eq('anime_id', currentAnime.mal_id)
            .maybeSingle();

        if (yaVoto) {
            // Reemplazamos el alert feo por tu Alerta de Oro
            await goldAlert({
                title: "VOTO REGISTRADO",
                text: "Ya has calificado este anime anteriormente. ¡Tu voto es permanente en la base de datos de AiduMe!",
                icon: "⭐"
            });
            return;
        }

        // 2. Usamos INSERT en lugar de UPSERT para mayor seguridad
        const { error } = await _db
            .from('valoraciones')
            .insert([{
                usuario_nombre: currentUser,
                anime_id: currentAnime.mal_id,
                estrellas: stars
            }]);

        if (error) throw error;

        // 3. Bloqueamos las estrellas visualmente
        updateStars(stars, true);
        cargarPuntuacionComunidad(currentAnime.mal_id);

        // Alerta de éxito al registrar el voto
        await goldAlert({
            title: "¡VALORACIÓN ENVIADA!",
            text: `Le diste ${stars} estrellas a ${currentAnime.title || 'este anime'}. ¡Gracias por ayudar a la comunidad!`,
            icon: "✨"
        });
        
    } catch (err) {
        console.error("Error al votar:", err.message);
        await goldAlert({
            title: "ERROR DE CONEXIÓN",
            text: "No se pudo registrar tu calificación en este momento. Inténtalo de nuevo más tarde.",
            icon: "⚡"
        });
    }
}

// 2. CALCULAR EL PROMEDIO DE LA WEB
async function cargarPuntuacionComunidad(id) {
    const scoreElem = document.getElementById('score-pct');
    
    try {
        const { data: votos, error } = await _db
            .from('valoraciones')
            .select('estrellas')
            .eq('anime_id', id);

        if (error) throw error;

        if (!votos || votos.length === 0) {
            scoreElem.innerText = "Sin votos aún";
            return;
        }

        // Cálculo del promedio
        const suma = votos.reduce((acc, v) => acc + v.estrellas, 0);
        const promedio = (suma / votos.length).toFixed(1);
        const porcentaje = ((promedio / 5) * 100).toFixed(0);

        scoreElem.innerHTML = `${promedio} ⭐ <span style="font-size:0.8rem; opacity:0.6;">(${porcentaje}% Aprobación)</span>`;

    } catch (err) {
        console.error("Error al calcular score:", err.message);
    }
}

function updateGlobalUI(id, stars = 0) {
    const pct = (75 + (id % 20) + (stars * 0.5)).toFixed(1);
    document.getElementById('score-pct').innerText = pct + "% Aprobación";
}

async function cargarDuelo() {
    if (!currentUser) return; 

    try {
        // 1. Crear Semilla basada en la fecha (Ej: 20260418)
        const hoy = new Date();
        const fechaSemilla = hoy.getFullYear() * 10000 + (hoy.getMonth() + 1) * 100 + hoy.getDate();
        
        // 2. Elegir una página aleatoria (entre 1 y 50) que solo cambie cada día
        const paginaDia = (fechaSemilla % 50) + 1;

        // 3. Pedir animes de esa página específica (Variedad real)
        const r = await fetch(`https://api.jikan.moe/v4/anime?page=${paginaDia}&limit=25&order_by=score&sort=desc`);
        const j = await r.json();
        
        if (!j.data || j.data.length < 2) {
            // Si la página falla, intentamos con el top por defecto como respaldo
            const backup = await fetch('https://api.jikan.moe/v4/top/anime?limit=25');
            const jBackup = await backup.json();
            j.data = jBackup.data;
        }

        // 4. Rotación diaria: Mezclamos y elegimos dos animes basados en la fecha
        // Usamos la semilla para que durante todo el día salgan los mismos dos
        const s = j.data.sort((a, b) => (a.mal_id * fechaSemilla) % 10 - (b.mal_id * fechaSemilla) % 10);
        duelAnimes = [s[0], s[1]]; 

        // 5. Actualizar la Interfaz (UI)
        const img1 = document.getElementById('img1');
        const img2 = document.getElementById('img2');
        const t1 = document.getElementById('t1');
        const t2 = document.getElementById('t2');

        if (img1 && img2) {
            img1.src = duelAnimes[0].images.jpg.large_image_url || duelAnimes[0].images.jpg.image_url;
            img2.src = duelAnimes[1].images.jpg.large_image_url || duelAnimes[1].images.jpg.image_url;
            
            // Usamos un substring un poco más largo (15) para que se entienda el nombre
            t1.innerText = duelAnimes[0].title.substring(0, 15) + "...";
            t2.innerText = duelAnimes[1].title.substring(0, 15) + "...";
            
            const timer = document.getElementById('battle-timer');
            if (timer) timer.innerText = "¡VOTA POR TU FAVORITO!";
        }

        // 6. Base de datos: Cargamos los votos reales
        await actualizarMarcadorGlobal();
        await actualizarVotosUI(); 

    } catch(e) { 
        console.log("Error duelo", e); 
        const timer = document.getElementById('battle-timer');
        if (timer) timer.innerText = "Error al cargar";
    }
}

async function actualizarMarcadorGlobal() {
    const todayString = getTodayString(); // Use daily string
    const profileData = JSON.parse(localStorage.getItem('aidume_profile'));
    const isAdmin = profileData && (profileData.rol === 'dueño' || profileData.rol === 'admin' || profileData.rol === 'moderador');

    for (let i = 0; i < 2; i++) {
        const { count, error } = await _db
            .from('torneo_votos')
            .select('*', { count: 'exact', head: true })
            .eq('anime_id', duelAnimes[i].mal_id)
            .eq('dia_voto', todayString); // Use dia_voto
        
        if (!error) {
            const votosReal = count || 0;
            
            // 2. Actualizar el texto en el HTML (solo a admin/dueño)
            const labelVotos = document.getElementById(`v${i+1}`);
            if (labelVotos) {
                if (isAdmin) labelVotos.innerText = votosReal + " votos";
                else labelVotos.innerText = "";
            }
        }
    }
}

async function votarDuelo(index) {
    if (!currentUser) {
        return goldAlert({ 
            title: "INICIA SESIÓN", 
            text: "Debes estar logueado para participar en el torneo.", 
            icon: "👤" 
        });
    }

    const todayString = getTodayString(); // Use daily string

    try {
        // 1. Verificar límites de votos y obtener saldo actual de fichas
        const [resVotos, resPerfil] = await Promise.all([
            _db.from('torneo_votos')
                .select('*', { count: 'exact', head: true })
                .eq('usuario_nombre', currentUser)
                .eq('dia_voto', todayString), // Use dia_voto
            _db.from('perfiles')
                .select('aidufichas')
                .ilike('nombre', currentUser)
                .single()
        ]);

        if (resVotos.count >= 1) { // Changed from 3 to 1
            return goldAlert({
                title: "LÍMITE ALCANZADO",
                text: "¡Ya votaste en el torneo de hoy!",
                icon: "🚫"
            });
        }

        const misFichas = resPerfil.data?.aidufichas || 0;

        // 2. PEDIR APUESTA (Usando Gold Alert con Input)
        const montoApuesta = await goldAlert({
            title: "APOSTAR AIDUFICHAS",
            text: `¿Cuántas fichas quieres apostar por ${duelAnimes[index].title}?\n(Tienes: ${misFichas} 💰)`,
            icon: "🎲",
            showInput: true,
            showCancel: true,
            confirmText: "APOSTAR Y VOTAR"
        });

        if (montoApuesta === null) return; // Canceló

        const apuestaInt = parseInt(montoApuesta) || 0;
        if (apuestaInt < 0) return goldAlert({ text: "La apuesta no puede ser negativa.", icon: "❌" });
        if (apuestaInt > misFichas) {
            return goldAlert({ title: "SALDO INSUFICIENTE", text: "No tienes suficientes Aidufichas para esta apuesta.", icon: "📉" });
        }

        // 3. Registrar voto con la apuesta
        const { error: errInsert } = await _db
            .from('torneo_votos')
            .insert([{
                usuario_nombre: currentUser,
                anime_id: duelAnimes[index].mal_id,
                anime_titulo: duelAnimes[index].title, // Keep for notifications
                dia_voto: todayString, // Use dia_voto
                apuesta: apuestaInt
            }]);

        if (errInsert) throw errInsert;

        // 4. Descontar fichas del perfil
        if (apuestaInt > 0) {
            await ganarRecompensaGold({ fichas: -apuestaInt, silencioso: true });
        }

        goldAlert({
            title: "APUESTA REALIZADA",
            text: `Has apostado ${apuestaInt} fichas por ${duelAnimes[index].title}. ¡Si gana al final del día, duplicarás tu premio!`, // Updated message
            icon: "🔥"
        });

        await actualizarMarcadorGlobal();
        await actualizarVotosUI();
        
    } catch (err) {
        console.error("Error al votar:", err.message);
        
        // --- REEMPLAZO DEL ALERT DE ERROR ---
        goldAlert({
            title: "ERROR DE CONEXIÓN",
            text: "No pudimos registrar tu voto. Por favor, intenta de nuevo.",
            icon: "❌"
        });
    }
}

async function actualizarVotosUI() {
    if (!currentUser) return;
    const todayString = getTodayString(); // Use daily string

    const { count } = await _db
        .from('torneo_votos')
        .select('*', { count: 'exact', head: true })
        .eq('usuario_nombre', currentUser)
        .eq('dia_voto', todayString); // Use dia_voto

    // Ya no mostramos el contador de votos restantes ni deshabilitamos los botones.
    // La lógica de un voto por día se maneja en votarDuelo().
    // Los botones siempre estarán activos visualmente.
    document.querySelectorAll('.battle-item').forEach(el => el.style.pointerEvents = "auto");
}

/**
 * Verifica y actualiza la racha de días consecutivos
 */
async function verificarRachaDias() {
    if (!currentUser) return;
    try {
        const { data: perfil } = await _db.from('perfiles').select('racha_dias, ultima_racha_fecha').ilike('nombre', currentUser).single();
        if (!perfil) return;

        const hoy = new Date();
        const fechaHoyStr = hoy.toISOString().split('T')[0]; 
        const ultimaFecha = perfil.ultima_racha_fecha;

        if (ultimaFecha === fechaHoyStr) return; // Ya entró hoy

        let nuevaRacha = 1;
        if (ultimaFecha) {
            const dUltima = new Date(ultimaFecha + 'T12:00:00');
            const dHoy = new Date(fechaHoyStr + 'T12:00:00');
            const diffDias = Math.round((dHoy - dUltima) / (1000 * 60 * 60 * 24));

            if (diffDias === 1) {
                nuevaRacha = (perfil.racha_dias || 0) + 1;
            } else if (diffDias > 1) {
                nuevaRacha = 1; // Racha rota por olvido
                goldAlert({ title: "RACHA ROTA", text: "Has perdido tu racha de días. ¡Vuelve a empezar de cero!", icon: "🥀" });
            }
        }

        await _db.from('perfiles').update({ 
            racha_dias: nuevaRacha, 
            ultima_racha_fecha: fechaHoyStr 
        }).ilike('nombre', currentUser);

        if (nuevaRacha > 1 && nuevaRacha % 5 === 0) {
            goldAlert({ title: "¡RACHA IMPARABLE!", text: `¡Llevas ${nuevaRacha} días seguidos en AiduMe! Tu poder aumenta.`, icon: "🔥" });
        }
    } catch (e) { console.error("Error en racha:", e); }
}

/**
 * Devuelve el HTML de la etiqueta de racha según los días
 */
function obtenerHtmlRacha(dias) {
    if (!dias || dias < 1) return "";
    let imgNum = 1;
    if (dias >= 3 && dias < 7) imgNum = 2;
    else if (dias >= 7 && dias < 15) imgNum = 3;
    else if (dias >= 15 && dias < 30) imgNum = 4;
    else if (dias >= 30) imgNum = 5;

    return `<span class="racha-item" title="Ver racha" 
                  onclick="event.stopPropagation(); goldAlert({ title: 'RACHA ACTIVA', text: '¡Este usuario tiene una racha de ${dias} días consecutivos!', icon: '🔥' });"
                  style="cursor:pointer;">
                <img src="insignias/racha${imgNum}.png" style="height:28px; vertical-align:middle;">
            </span>`;
}

/**
 * Carga y muestra el ranking semanal de animes (Lunes-Sábado) 
 * y revela al ganador los Domingos (Estilo UFA).
 */
async function verificarGanadorDiario() {
    const yesterdayString = getYesterdayString();
    
    // 1. Intentamos obtener el bloqueo insertando la fila del resultado (evita múltiples procesos en paralelo)
    const { error: lockError } = await _db
        .from('torneo_resultados_diarios')
        .insert({
            dia: yesterdayString,
            ganador_anime_id: null,
            ganador_anime_titulo: null,
            processed: true
        });

    if (lockError) {
        // Si hay error (como clave primaria duplicada), significa que ya se procesó o está en proceso por otro cliente
        return;
    }

    // If not processed, calculate winner and distribute rewards
    try {
        const { data: votes, error: votesError } = await _db
            .from('torneo_votos')
            .select('anime_id, anime_titulo, usuario_nombre, apuesta')
            .eq('dia_voto', yesterdayString);

        if (votesError) throw votesError;

        if (!votes || votes.length === 0) {
            // No votes for yesterday, it's already marked as processed (winning fields remain null)
            console.log(`No hubo votos para el torneo del día ${yesterdayString}.`);
            return;
        }

        // Calculate total votes for each anime
        const animeVotes = {};
        votes.forEach(vote => {
            if (!animeVotes[vote.anime_id]) {
                animeVotes[vote.anime_id] = { count: 0, title: vote.anime_titulo };
            }
            animeVotes[vote.anime_id].count++;
        });

        let winningAnimeId = null;
        let winningAnimeTitle = null;
        let maxVotes = -1;

        for (const id in animeVotes) {
            if (animeVotes[id].count > maxVotes) {
                maxVotes = animeVotes[id].count;
                winningAnimeId = parseInt(id);
                winningAnimeTitle = animeVotes[id].title;
            }
        }

        // Distribute rewards and send notifications
        const processedUsers = new Set(); // To avoid duplicate notifications/rewards for users who voted multiple times
        for (const vote of votes) {
            if (processedUsers.has(vote.usuario_nombre)) continue; // Skip if already processed for this user

            const esGanador = (vote.anime_id === winningAnimeId);
            const reward = esGanador ? (vote.apuesta * 2) : 0;

            if (esGanador && reward > 0) {
                // 1. Obtener las fichas actuales de ese usuario ganador (esté online u offline)
                const { data: perfilGanador, error: getErr } = await _db
                    .from('perfiles')
                    .select('aidufichas')
                    .ilike('nombre', vote.usuario_nombre)
                    .single();

                if (!getErr && perfilGanador) {
                    const nuevasFichas = (perfilGanador.aidufichas || 0) + reward;
                    // 2. Actualizar las fichas directamente en la base de datos para ese usuario específico
                    await _db
                        .from('perfiles')
                        .update({ aidufichas: nuevasFichas })
                        .ilike('nombre', vote.usuario_nombre);
                    
                    console.log(`🏆 Torneo Diario: Otorgadas ${reward} fichas a ${vote.usuario_nombre} (ganador).`);
                }
            }

            // 3. Notificación local en el navegador del cliente SOLO si es el usuario conectado
            if (currentUser && vote.usuario_nombre.toLowerCase() === currentUser.toLowerCase()) {
                // Refrescar su UI en pantalla si está online
                if (typeof actualizarPerfilDesdeSQL === 'function') {
                    actualizarPerfilDesdeSQL();
                }

                if (esGanador) {
                    if (reward > 0) {
                        lanzarNotificacionSistema(
                            "🏆 ¡GANASTE EL TORNEO DIARIO!",
                            `¡Felicidades! Tu apuesta por "${vote.anime_titulo}" ha ganado. Has recibido ${reward} Aidufichas.`,
                            'logo-grande.png'
                        );
                    } else {
                        lanzarNotificacionSistema(
                            "🏆 ¡GANASTE EL TORNEO DIARIO!",
                            `¡Felicidades! Tu anime "${vote.anime_titulo}" ha ganado el torneo diario.`,
                            'logo-grande.png'
                        );
                    }
                } else {
                    lanzarNotificacionSistema(
                        "😔 TORNEO DIARIO",
                        `Tu apuesta por "${vote.anime_titulo}" no ha ganado el torneo de ayer. ¡Más suerte la próxima vez!`,
                        'logo-grande.png'
                    );
                }
            }
            processedUsers.add(vote.usuario_nombre);
        }

        // 4. Actualizar el registro del resultado con el ganador real
        await _db.from('torneo_resultados_diarios').update({
            ganador_anime_id: winningAnimeId,
            ganador_anime_titulo: winningAnimeTitle,
            processed: true
        }).eq('dia', yesterdayString);

        console.log(`Resultados del torneo diario para ${yesterdayString} procesados. Ganador: ${winningAnimeTitle}`);

    } catch (err) {
        console.error(`Error al procesar el ganador diario para ${yesterdayString}:`, err);
    }
}

// Remove the old getWeekNumber and verificarGanadorSemanal as they are no longer needed for tournament logic
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}


async function verificarGanadorSemanal() { // This function is now unused, but kept for context.
    const ahora = new Date();
    if (ahora.getDay() !== 0) return; // Only execute on Sundays

    const semanaActual = getWeekNumber(ahora); // This will still calculate week number
    
    // Consultar el anime con más votos de esta semana
    const { data, error } = await _db
        .from('torneo_votos')
        .select('anime_titulo, anime_id')
        .eq('semana_voto', semanaActual);

    if (data.length > 0) {
        // Lógica para contar cuál título se repite más
        const conteo = data.reduce((acc, curr) => {
            acc[curr.anime_titulo] = (acc[curr.anime_titulo] || 0) + 1;
            return acc;
        }, {});

        const ganador = Object.keys(conteo).reduce((a, b) => conteo[a] > conteo[b] ? a : b);

        // Enviar Notificación Real
        if (Notification.permission === "granted") {
            new Notification("🏆 ¡Tenemos un Ganador!", {
                body: `El anime de la semana es: ${ganador}. ¡Gracias por votar!`,
                icon: 'logo_oro.png' 
            });
        }
    }
}


/*function actualizarLogros() {
    const h = JSON.parse(localStorage.getItem('hist_' + currentUser)) || [];
    const v = JSON.parse(localStorage.getItem('votos_semana_' + currentUser)) || [];
    const b1 = document.getElementById('badge-1'), b2 = document.getElementById('badge-2'), b3 = document.getElementById('badge-3');
    if(currentUser && b1) b1.classList.add('unlocked');
    if(h.length >= 3 && b2) b2.classList.add('unlocked');
    if(v.length >= 1 && b3) b3.classList.add('unlocked');
}*/


async function filtrarPorGenero(id, btn) {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    // CORRECCIÓN: Comillas invertidas para URL de género
    let url = id === 0 ? 'https://api.jikan.moe/v4/top/anime?limit=12' : `https://api.jikan.moe/v4/anime?genres=${id}&limit=12&order_by=score&sort=desc`;
    const r = await fetch(url); const j = await r.json(); renderGrid(j.data, 'lista');
}

// ===== SISTEMA DE ESTADÍSTICAS DE VISUALIZACIÓN =====

/**
 * Calcula todas las estadísticas de visualización para un usuario
 */
async function calcularEstadisticasVisualizacion(nombreUsuario) {
    if (!nombreUsuario) return null;
    
    try {
        // 1. Ejecutar todas las consultas en paralelo
        const [
            favoritosRes,
            comentariosRes,
            valoracionesRes,
            perfilRes
        ] = await Promise.all([
            _db.from('favoritos').select('id', { count: 'exact', head: true }).ilike('usuario_nombre', nombreUsuario),
            _db.from('comentarios').select('id', { count: 'exact', head: true }).eq('usuario', nombreUsuario),
            _db.from('valoraciones').select('id', { count: 'exact', head: true }).ilike('usuario_nombre', nombreUsuario),
            _db.from('perfiles').select('racha_dias').ilike('nombre', nombreUsuario).single()
        ]);

        const totalFavoritos = favoritosRes.count || 0;
        const totalComentarios = comentariosRes.count || 0;
        const totalValoraciones = valoracionesRes.count || 0;
        const rachaDias = perfilRes.data?.racha_dias || 0;

        // Contar episodios desde el JSON del perfil (log_vistos)
        const { data: perfilData } = await _db
            .from('perfiles')
            .select('log_vistos')
            .ilike('nombre', nombreUsuario)
            .single();
        
        const logVistos = perfilData?.log_vistos || {};
        let totalEpisodios = 0;
        let animesCompletados = 0;
        
        // Sumar todos los episodios vistos del JSON
        for (const animeId in logVistos) {
            const eps = logVistos[animeId];
            if (Array.isArray(eps)) {
                totalEpisodios += eps.length;
                if (eps.length > 0) animesCompletados++;
            }
        }

        // 2. Calcular horas estimadas (promedio 24 min por episodio)
        const minutosTotales = totalEpisodios * 24;
        const horasEstimadas = Math.floor(minutosTotales / 60);
        const minutosRestantes = minutosTotales % 60;

        return {
            episodios: totalEpisodios,
            horas: horasEstimadas,
            minutos: minutosRestantes,
            horasTexto: `${horasEstimadas}h ${minutosRestantes}m`,
            animesCompletados: animesCompletados,
            comentarios: totalComentarios,
            valoraciones: totalValoraciones,
            racha: rachaDias,
            favoritos: totalFavoritos
        };
    } catch (err) {
        console.error("Error en calcularEstadisticasVisualizacion:", err);
        return null;
    }
}

// ===== SISTEMA DE REACCIONES Y RESPUESTAS EN CHAT =====

// Emojis disponibles para reacciones rápidas
const EMOJIS_REACCION = ["👍", "❤️", "😂", "😮", "😢", "😡", "🔥", "🎉"];

/**
 * Da o quita una reacción a un mensaje de chat (global o privado)
 */
async function toggleReaccionChat(mensajeId, tablaOrigen, emoji) {
    if (!currentUser) {
        goldAlert({ title: "INICIA SESIÓN", text: "Debes estar logueado para reaccionar.", icon: "👤" });
        return null;
    }

    try {
        // Verificar si ya existe esa reacción del usuario
        const { data: existente } = await _db
            .from('chat_reactions')
            .select('id')
            .eq('mensaje_id', mensajeId)
            .eq('tabla_origen', tablaOrigen)
            .eq('usuario', currentUser)
            .eq('emoji', emoji)
            .maybeSingle();

        if (existente) {
            // Ya reaccionó con ese emoji → quitarlo
            await _db.from('chat_reactions').delete().eq('id', existente.id);
            return { accion: 'removed', emoji };
        } else {
            // No tiene esa reacción → agregarla
            await _db.from('chat_reactions').insert([{
                mensaje_id: mensajeId,
                tabla_origen: tablaOrigen,
                usuario: currentUser,
                emoji: emoji
            }]);
            return { accion: 'added', emoji };
        }
    } catch (err) {
        console.error("Error en toggleReaccionChat:", err);
        return null;
    }
}

/**
 * Obtiene todas las reacciones agrupadas para un mensaje
 */
async function obtenerReaccionesChat(mensajeId, tablaOrigen) {
    try {
        const { data } = await _db
            .from('chat_reactions')
            .select('emoji, usuario')
            .eq('mensaje_id', mensajeId)
            .eq('tabla_origen', tablaOrigen);

        if (!data || data.length === 0) return [];

        // Agrupar por emoji
        const grupos = {};
        data.forEach(r => {
            if (!grupos[r.emoji]) grupos[r.emoji] = [];
            grupos[r.emoji].push(r.usuario);
        });

        // Convertir a array de { emoji, count, usuarios, usuarioDioLike }
        return Object.keys(grupos).map(emoji => ({
            emoji,
            count: grupos[emoji].length,
            usuarios: grupos[emoji],
            usuarioReacciono: currentUser ? grupos[emoji].some(u => u.toLowerCase() === currentUser.toLowerCase()) : false
        }));
    } catch (err) {
        console.error("Error en obtenerReaccionesChat:", err);
        return [];
    }
}

/**
 * Renderiza el HTML de las reacciones para un mensaje
 */
function renderizarReaccionesChat(reacciones) {
    if (!reacciones || reacciones.length === 0) return '';

    return `
        <div class="chat-reactions-bar">
            ${reacciones.map(r => `
                <span class="chat-reaction-badge ${r.usuarioReacciono ? 'reaction-active' : ''}" 
                      onclick="event.stopPropagation(); toggleReaccionChatDesdeUI(${r.mensajeId}, '${r.tablaOrigen}', '${r.emoji}')"
                      title="${r.usuarios.join(', ')}">
                    ${r.emoji} <small>${r.count}</small>
                </span>
            `).join('')}
        </div>`;
}

/**
 * Muestra el selector de reacciones (popup) al lado del mensaje
 */
function mostrarSelectorReacciones(mensajeId, tablaOrigen, btn) {
    // Cerrar cualquier selector abierto
    const existente = document.querySelector('.reaction-picker-popup');
    if (existente) existente.remove();

    const picker = document.createElement('div');
    picker.className = 'reaction-picker-popup';
    picker.innerHTML = EMOJIS_REACCION.map(e => 
        `<span class="reaction-option" onclick="event.stopPropagation(); toggleReaccionChatDesdeUI(${mensajeId}, '${tablaOrigen}', '${e}'); this.closest('.reaction-picker-popup').remove();">${e}</span>`
    ).join('');

    // Posicionar cerca del botón
    const rect = btn.getBoundingClientRect();
    picker.style.left = `${Math.max(5, rect.left - 20)}px`;
    picker.style.bottom = `${window.innerHeight - rect.top + 10}px`;
    document.body.appendChild(picker);

    // Cerrar al hacer clic fuera
    setTimeout(() => {
        document.addEventListener('click', function cerrarPicker(e) {
            if (!picker.contains(e.target) && e.target !== btn) {
                picker.remove();
                document.removeEventListener('click', cerrarPicker);
            }
        });
    }, 100);
}

/**
 * Función global para toggle de reacción desde UI
 */
window.toggleReaccionChatDesdeUI = async function(mensajeId, tablaOrigen, emoji) {
    const resultado = await toggleReaccionChat(mensajeId, tablaOrigen, emoji);
    if (!resultado) return;

    // Recargar las reacciones de ese mensaje
    const reacciones = await obtenerReaccionesChat(mensajeId, tablaOrigen);
    const contenedorMsj = document.querySelector(`[data-msg-id="${mensajeId}"][data-msg-table="${tablaOrigen}"]`);
    if (!contenedorMsj) return;

    const barExistente = contenedorMsj.querySelector('.chat-reactions-bar');
    const nuevoHtml = renderizarReaccionesChat(reacciones.map(r => ({ ...r, mensajeId, tablaOrigen })));
    
    if (barExistente) {
        barExistente.outerHTML = nuevoHtml;
    } else {
        // Insertar después del texto del mensaje
        const textoDiv = contenedorMsj.querySelector('.chat-text') || contenedorMsj.querySelector('.priv-msg-text');
        if (textoDiv) {
            textoDiv.insertAdjacentHTML('afterend', nuevoHtml);
        }
    }
};

/**
 * Prepara una respuesta a un mensaje (abre el input con la referencia)
 */
function responderAMensaje(mensajeId, usuarioOrigen, textoOriginal, inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;

    // Guardar la referencia de respuesta en un atributo data del input
    input.dataset.replyTo = JSON.stringify({
        mensaje_id: mensajeId,
        usuario: usuarioOrigen,
        texto: textoOriginal.substring(0, 80) + (textoOriginal.length > 80 ? '...' : '')
    });

    // Mostrar barra de "respondiendo a" sobre el input area
    let barra = document.getElementById(`reply-bar-${inputId}`);
    if (!barra) {
        barra = document.createElement('div');
        barra.id = `reply-bar-${inputId}`;
        barra.className = 'reply-preview-bar';
        // Insertar ANTES del chat-input-area (el contenedor padre del input)
        const inputArea = input.closest('.chat-input-area');
        if (inputArea && inputArea.parentElement) {
            inputArea.parentElement.insertBefore(barra, inputArea);
        } else {
            input.parentElement.insertBefore(barra, input);
        }
    }
    
    barra.innerHTML = `
        <div class="reply-preview-content">
            <span class="reply-preview-icon">↩️</span>
            <div class="reply-preview-text">
                <strong>${usuarioOrigen}</strong>: ${textoOriginal.substring(0, 60)}${textoOriginal.length > 60 ? '...' : ''}
            </div>
            <button class="reply-cancel-btn" onclick="cancelarRespuesta('${inputId}')">✕</button>
        </div>
    `;
    barra.style.display = 'flex';
    input.focus();
}

/**
 * Cancela la respuesta en curso
 */
function cancelarRespuesta(inputId) {
    const input = document.getElementById(inputId);
    if (input) delete input.dataset.replyTo;
    const barra = document.getElementById(`reply-bar-${inputId}`);
    if (barra) barra.style.display = 'none';
}

/**
 * Renderiza el HTML de la respuesta citada dentro de un mensaje
 */
function renderizarRespuestaCitada(replyToJson) {
    if (!replyToJson) return '';
    return `
        <div class="reply-quote">
            <div class="reply-quote-line"></div>
            <div class="reply-quote-content">
                <strong>${replyToJson.usuario || 'Usuario'}</strong>
                <span>${replyToJson.texto || ''}</span>
            </div>
        </div>`;
}

/**
 * Carga las reacciones de un mensaje en su contenedor
 */
async function cargarReaccionesEnMensaje(mensajeId, tablaOrigen) {
    const reacciones = await obtenerReaccionesChat(mensajeId, tablaOrigen);
    if (!reacciones || reacciones.length === 0) return;
    
    const contenedor = document.getElementById(`reacciones-${mensajeId}-${tablaOrigen}`);
    if (!contenedor) return;
    
    contenedor.innerHTML = renderizarReaccionesChat(reacciones.map(r => ({ ...r, mensajeId, tablaOrigen })));
}

// ===== SISTEMA DE LIKES EN COMENTARIOS =====

/**
 * Da o quita un like a un comentario. Retorna el nuevo estado (true=liked, false=unliked).
 */
async function toggleLikeComentario(comentarioId) {
    if (!currentUser) {
        goldAlert({ title: "INICIA SESIÓN", text: "Debes estar logueado para dar likes.", icon: "👤" });
        return null;
    }

    try {
        // 1. Obtener la lista actual de likes de este comentario
        const { data, error: fetchError } = await _db
            .from('comentarios')
            .select('likes_usuarios')
            .eq('id', comentarioId)
            .single();

        if (fetchError) throw fetchError;

        // Nos aseguramos de tener un array vacío si por alguna razón viene null
        let likes = data?.likes_usuarios || [];
        const yaDioLike = likes.includes(currentUser);
        let nuevosLikes;

        if (yaDioLike) {
            // 2. Ya dio like → filtrar el array para quitar al usuario actual
            nuevosLikes = likes.filter(usuario => usuario !== currentUser);
        } else {
            // 3. No tiene like → agregarlo al array
            nuevosLikes = [...likes, currentUser];
        }

        // 4. Actualizar la fila del comentario con el nuevo array de likes
        const { error: updateError } = await _db
            .from('comentarios')
            .update({ likes_usuarios: nuevosLikes })
            .eq('id', comentarioId);

        if (updateError) throw updateError;

        // Retorna true si ahora tiene like (se agregó), o false si se quitó
        return !yaDioLike; 

    } catch (err) {
        console.error("Error en toggleLikeComentario:", err);
        goldAlert({ title: "ERROR", text: "No se pudo procesar el like.", icon: "❌" });
        return null;
    }
}

/**
 * Obtiene el conteo de likes para un comentario y si el usuario actual dio like.
 */
async function obtenerEstadoLikes(comentarioId) {
    try {
        // Traemos únicamente la columna de likes del comentario específico
        const { data, error } = await _db
            .from('comentarios')
            .select('likes_usuarios')
            .eq('id', comentarioId)
            .single();

        if (error) throw error;

        const likes = data?.likes_usuarios || [];
        const conteo = likes.length;
        const usuarioDioLike = currentUser ? likes.includes(currentUser) : false;

        return { conteo, usuarioDioLike };
    } catch (err) {
        console.error("Error en obtenerEstadoLikes:", err);
        return { conteo: 0, usuarioDioLike: false };
    }
}

// ==========================================
// DETECTOR DE SPOILERS (SIN MODIFICAR TABLAS)
// ==========================================

const PALABRAS_SPOILER = [
    "muere", "muera", "muerto", "murio", "morira", "mueran",
    "fallece", "fallecio", "palma", "palmo", "perece", "perecio",
    "asesinado", "asesinar", "asesino", "mato", "mata", "matan",
    "ejecutado", "ejecutan", "decapitado", "desmembrado", "sacrificio", "sacrifica",
    "suicida", "suicido", "se suicida", "cadaver", "tumba",
    "traiciona", "traicion", "traidor", "impostor", "infiltrado",
    "verdadero padre", "verdadera madre", "hermano de", "hermana de", "hijo de",
    "identidad", "en realidad es", "resulta ser", "es el rey", "es el jefe",
    "villano", "antagonista", "el malo", "culpable", "identidad oculta",
    "mente maestra", "doble agente", "espia",
    "revive", "resucita", "resucito", "reencarna", "reencarno",
    "pierde el poder", "se queda ciego", "pierde un brazo", "pierde la pierna",
    "desaparece", "se transforma", "nueva forma", "despierta el", "despertar",
    "gear 5", "power up", "evolucion", "se vuelve malo", "se corrompe",
    "posesion", "poseido", "controla su cuerpo", "fusion",
    "en el manga", "en la novela", "el manga", "la novela", "spoiler", "spoilers",
    "adelanto", "lei que", "leí el", "ya salio el", "capitulo del manga", 
    "scan", "scans", "leaks", "filtraciones", "filtracion", "al final del", 
    "en el final", "fin del manga", "se quedan juntos", "terminan juntos", 
    "se besan", "se le declara", "lo rechaza", "la rechaza", "se casa con", 
    "se casan", "tienen un hijo", "rompen", "se separan"
];

function verificarTextoSpoiler(texto) {
    if (!texto) return { contiene: false, palabra: null };
    
    // Convertimos a minúsculas y limpiamos tildes/acentos
    const textoLimpio = texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    for (const palabra of PALABRAS_SPOILER) {
        const regex = new RegExp(`\\b${palabra}\\b`, 'i');
        if (regex.test(textoLimpio)) {
            return { contiene: true, palabra: palabra };
        }
    }
    return { contiene: false, palabra: null };
}

// ==========================================
// FUNCIÓN PRINCIPAL POSTEAR COMENTARIO
// ==========================================

async function postearComentario() {
    const input = document.getElementById('comment-input');
    const text = input.value.trim(); 
    if(!text || !currentAnime || !currentUser) return;

    // 🚨 1. VALIDACIÓN DE INSULTOS, OFENSAS Y LINKS
    if (contieneOfensa(text)) {
        return goldAlert({
            title: "CONTENIDO NO PERMITIDO",
            text: "Tu comentario contiene palabras inapropiadas, insultos o enlaces externos. Por favor, modifícalo para mantener una comunidad sana.",
            icon: "🚫",
            confirmText: "CORREGIR"
        });
    }

    try {
        // 2. CONSULTAR EL ÚLTIMO COMENTARIO (Antispam)
        const { data: ultimoComentario, error: errCheck } = await _db
            .from('comentarios')
            .select('fecha')
            .eq('usuario', currentUser)
            .eq('anime_id', currentAnime.mal_id)
            .order('fecha', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (errCheck) throw errCheck;

        // 3. LÓGICA DE TIEMPO (Antispam)
        if (ultimoComentario) {
            const ahora = new Date();
            const fechaUltimo = new Date(ultimoComentario.fecha);
            const diferenciaMs = ahora - fechaUltimo;
            const dosHorasMs = 2 * 60 * 60 * 1000; 

            if (diferenciaMs < dosHorasMs) {
                const minutosRestantes = Math.ceil((dosHorasMs - diferenciaMs) / (60 * 1000));
                const horas = Math.floor(minutosRestantes / 60);
                const mins = minutosRestantes % 60;

                return goldAlert({
                    title: "SISTEMA ANTISPAM",
                    text: `¡Hola! Para evitar el spam, debes esperar ${horas}h ${mins}min antes de volver a comentar en este anime.`,
                    icon: "⏳",
                    confirmText: "ENTENDIDO"
                });
            }
        }

        // --- VALIDACIÓN DE SPOILERS ---
        let marcaSpoiler = false;
        const analisisSpoiler = verificarTextoSpoiler(text);

        if (analisisSpoiler.contiene) {
            const quiereMarcar = await goldAlert({
                title: "¡ALERTA DE SPOILER!",
                text: `Detectamos expresiones sospechosas (palabra: "${analisisSpoiler.palabra}"). ¿Deseas publicarlo protegido como spoiler para la comunidad?`,
                icon: "⚠️",
                showCancel: true,
                confirmText: "SÍ, PUBLICAR",
                cancelText: "CANCELAR"
            });

            // Si el usuario cancela porque prefiere reescribirlo, detenemos la ejecución
            if (!quiereMarcar) return; 
            
            marcaSpoiler = true;
        }

        // --- OBTENER EL AVATAR ACTUAL DEL PERFIL ---
        const { data: perfil } = await _db
            .from('perfiles')
            .select('avatar_id')
            .eq('nombre', currentUser)
            .single();

        const miAvatarId = perfil ? perfil.avatar_id : '1';

        // --- PREPARAR EL TEXTO FINAL ---
        // Si tiene spoiler, le concatenamos la advertencia al string original
        const textoFinal = marcaSpoiler ? `[SPOILER ALERT] 🙈: ${text}` : text;

        // 4. ENVIAR COMENTARIO (Mantiene intacta tu estructura original de Supabase)
        const { error: errInsert } = await _db
            .from('comentarios')
            .insert([{ 
                anime_id: currentAnime.mal_id, 
                usuario: currentUser, 
                comentario: textoFinal, 
                avatar_id: miAvatarId
            }]);

        if (errInsert) throw errInsert;

        input.value = "";
        cargarComentarios(currentAnime.mal_id);

        await goldAlert({
            title: marcaSpoiler ? "SPOILER PUBLICADO" : "¡COMENTARIO PUBLICADO!",
            text: marcaSpoiler 
                ? "Tu comentario se publicó anteponiendo la advertencia de spoiler." 
                : "Tu mensaje ha sido publicado con éxito en la comunidad.",
            icon: marcaSpoiler ? "🙈" : "💬",
            confirmText: "GENIAL"
        });
        
    } catch (err) {
        console.error("Error al comentar:", err.message);
        
        await goldAlert({
            title: "UPS...",
            text: "Hubo un error al publicar tu comentario. Revisa tu conexión.",
            icon: "❌"
        });
    }
}


// --- 1. PROCESADOR DE TEXTO INTEGRADO (SPOILERS MÉTODOS MANUAL Y AUTOMÁTICO) ---
function procesarTextoComentario(texto) {
    if (!texto) return "";

    let esSpoiler = false;
    let textoReal = texto;

    // Detectamos si viene del flujo automático o del comando manual anterior
    if (texto.startsWith("[SPOILER ALERT] 🙈:")) {
        esSpoiler = true;
        textoReal = texto.replace("[SPOILER ALERT] 🙈:", "").trim();
    } else if (texto.startsWith('/spoiler')) {
        esSpoiler = true;
        textoReal = texto.replace(/^\/spoiler\s*/i, '').trim();
    }

    // Si es spoiler, envolvemos el texto estructurado con tu CSS de peligro
    if (esSpoiler) {
        // Procesamos stickers y emojis dentro del contenido del spoiler
        const textoConStickers = parsearMensajeParaStickers(textoReal);
        
        return `
            <div class="spoiler-container" onclick="this.classList.toggle('revealed')">
                <div class="spoiler-overlay">
                    <span class="spoiler-badge">⚠️ SPOILER ALERT (Click para revelar)</span>
                </div>
                <div class="spoiler-text">
                    ${textoConStickers}
                </div>
            </div>
        `;
    }
    
    // Si es un comentario normal, lo procesamos directo con tu parseador de stickers
    return parsearMensajeParaStickers(texto);
}

// --- 2. CARGADOR DE COMENTARIOS ORIGINAL ---
// --- 1. CARGADOR DE COMENTARIOS (Llama con "await" al renderizador) ---
async function cargarComentarios(id) {
    const list = document.getElementById('lista-comentarios');
    if (!list) return; 
    list.innerHTML = ""; 

    try {
        // Traemos el comentario y los datos actuales del perfil del autor (avatar y premium)
        const { data: c, error } = await _db
            .from('comentarios')
            .select('*, perfiles(avatar_id, es_premium)') 
            .eq('anime_id', id)
            .order('fecha', { ascending: false });

        if (error) {
            console.error("Error con el vínculo de perfiles:", error.message);
            // Si falla el JOIN, intentamos cargar solo los comentarios sin perfiles
            const { data: backup } = await _db.from('comentarios').select('*').eq('anime_id', id).order('fecha', { ascending: false });
            if (backup) await renderizarComentarios(backup, list);
            return;
        }

        if (!c || c.length === 0) {
            list.innerHTML = "<p style='font-size:0.9rem; opacity:0.5; text-align:center; padding: 20px;'>No hay comentarios aún.</p>";
            return;
        }

        // Importante: Agregamos el "await" acá para esperar que termine de renderizar ordenadamente
        await renderizarComentarios(c, list);

    } catch (err) {
        console.error("Error fatal en comentarios:", err.message);
        list.innerHTML = "<p style='color:red; text-align:center;'>Error de conexión con la biblioteca.</p>";
    }
}

// --- 2. RENDERIZADOR DE COMENTARIOS ASÍNCRONO ORDENADO ---
async function renderizarComentarios(comentarios, contenedor) {
    contenedor.innerHTML = ""; // Limpiamos el contenedor por seguridad
    const todosLosAvatares = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
    
    try {
        // 1. Traemos los likes de TODOS los comentarios en paralelo antes de renderizar nada
        const comentariosConLikes = await Promise.all(
            comentarios.map(async (x) => {
                const estado = await obtenerEstadoLikes(x.id);
                return { 
                    ...x, 
                    conteo: estado.conteo, 
                    usuarioDioLike: estado.usuarioDioLike 
                };
            })
        );

        // 2. Ahora que tenemos toda la data junta, renderizamos de forma 100% sincrónica para blindar el orden
        comentariosConLikes.forEach((x) => { 
            const d = document.createElement('div'); 
            d.style = "background: rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 12px; border-left: 4px solid var(--gold); margin-bottom: 10px; width: 100%; box-sizing: border-box;"; 
            d.id = `comentario-${x.id}`;
            
            // LÓGICA DE ACTUALIZACIÓN AUTOMÁTICA DE AVATAR: 
            const perfilData = Array.isArray(x.perfiles) ? x.perfiles[0] : x.perfiles;
            const avId = (perfilData && perfilData.avatar_id) ? perfilData.avatar_id : (x.avatar_id || '1');
            const esPremium = perfilData?.es_premium || false;
            const av = todosLosAvatares.find(a => a.id === String(avId));
            const urlAvatar = av ? av.img : `https://api.dicebear.com/7.x/avataaars/svg?seed=${x.usuario}`;

            const likeClass = x.usuarioDioLike ? 'like-btn-active' : 'like-btn-inactive';
            const likeIcon = x.usuarioDioLike ? '❤️' : '🤍';

            d.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap: 12px;">
                    <img src="${urlAvatar}" class="go-to-profile" data-user="${x.usuario}"
                         style="width: 40px; height: 40px; border-radius: 50%; border: 2px solid ${esPremium ? 'var(--gold)' : '#333'}; background: #111; cursor: pointer; object-fit: cover;">
                    <div style="flex: 1;">
                        <strong class="go-to-profile" data-user="${x.usuario}"
                                style="color:${esPremium ? 'var(--gold)' : '#eee'}; font-size:0.8rem; display:block; cursor: pointer; width: fit-content;">
                            @${x.usuario} ${esPremium ? '👑' : ''}
                        </strong>
                        <!-- PROCESADO INTERACTIVO DE SPOILERS Y STICKERS -->
                        <span style="font-size:0.9rem; color: #ccc; word-wrap: break-word; display: block; width: 100%; margin-top: 4px;">
                            ${procesarTextoComentario(x.comentario)}
                        </span>
                        
                        <!-- BOTÓN DE LIKE -->
                        <div style="margin-top: 8px; display: flex; align-items: center; gap: 8px;">
                            <button onclick="toggleLikeComentarioUI(${x.id})" 
                                    class="like-btn ${likeClass}"
                                    style="background:none; border:none; cursor:pointer; font-size:0.9rem; padding: 2px 4px; border-radius: 6px; transition: 0.2s; display: flex; align-items: center; gap: 4px;">
                                <span class="like-icon">${likeIcon}</span>
                                <span class="like-count" style="font-size:0.75rem; color: ${x.usuarioDioLike ? '#ff4757' : '#888'}; font-weight: bold;">${x.conteo}</span>
                            </button>
                        </div>
                    </div>
                    <button onclick="reportarComentario(${x.id})" style="background:none; border:none; cursor:pointer; font-size:0.9rem; opacity:0.4;">🚩</button>
                </div>`; 

            // Vincular el click al perfil
            d.querySelectorAll('.go-to-profile').forEach(el => {
                el.onclick = () => verPerfilAjeno(el.getAttribute('data-user'));
            });
            
            contenedor.appendChild(d);
        });

    } catch (err) {
        console.error("Error al renderizar comentarios con likes:", err.message);
    }
}

/**
 * Función global para toggle de like desde UI
 */
window.toggleLikeComentarioUI = async function(comentarioId) {
    const resultado = await toggleLikeComentario(comentarioId);
    if (resultado === null) return; // Error o sin sesión
    
    // Actualizar solo el botón de like sin recargar todos los comentarios
    const comentarioDiv = document.getElementById(`comentario-${comentarioId}`);
    if (!comentarioDiv) return;
    
    const btn = comentarioDiv.querySelector('.like-btn');
    const icon = comentarioDiv.querySelector('.like-icon');
    const count = comentarioDiv.querySelector('.like-count');
    
    if (!btn || !icon || !count) return;
    
    const nuevoConteo = parseInt(count.innerText) + (resultado ? 1 : -1);
    
    if (resultado) {
        // Dio like
        icon.innerText = '❤️';
        count.innerText = nuevoConteo;
        count.style.color = '#ff4757';
        btn.classList.remove('like-btn-inactive');
        btn.classList.add('like-btn-active');
    } else {
        // Quitó like
        icon.innerText = '🤍';
        count.innerText = nuevoConteo;
        count.style.color = '#888';
        btn.classList.remove('like-btn-active');
        btn.classList.add('like-btn-inactive');
    }
};

async function cargarCalendario() {
    const c = document.getElementById('lista-calendario'); 
    if (!c) return;
    
    const cacheKey = 'aidume_calendar_cache_v2'; // Nueva versión para Anilist
    const cachedData = localStorage.getItem(cacheKey);

    if (cachedData) {
        renderizarHtmlCalendario(JSON.parse(cachedData));
    } else {
        c.innerHTML = "<p style='text-align:center; color:var(--gold); padding:20px;'>Cargando programación semanal...</p>";
    }

    // Query de Anilist para obtener los próximos 50 episodios que saldrán en los próximos 7 días
    const query = `
    query ($start: Int, $end: Int) {
      Page(perPage: 40) {
        airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
          airingAt
          episode
          media {
            idMal
            title { romaji english native }
            coverImage { large }
            description
            status
            episodes
          }
        }
      }
    }`;

    const now = Math.floor(Date.now() / 1000);
    const nextWeek = now + (7 * 24 * 60 * 60);

    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { start: now, end: nextWeek } })
        });

        if (!res.ok) {
            const errorBody = await res.text(); // Capturamos el cuerpo de la respuesta de error
            throw new Error(`Error de conexión con Anilist: ${res.status} ${res.statusText || ''} - ${errorBody}`);
        }

        const json = await res.json();
        const schedules = json.data.Page.airingSchedules;

        // Adaptamos Anilist al formato MAL-like que usa el resto de tu App
        const dataAdaptada = schedules.map(s => ({
            mal_id: s.media.idMal,
            title: s.media.title.romaji || s.media.title.english,
            titles: [
                { type: 'Default', title: s.media.title.romaji },
                { type: 'English', title: s.media.title.english }
            ],
            images: { jpg: { large_image_url: s.media.coverImage.large, image_url: s.media.coverImage.large } },
            synopsis: s.media.description,
            episodes: s.media.episodes,
            status: s.media.status === 'RELEASING' ? 'Currently Airing' : 'Finished',
            airingAt: s.airingAt, // Info vital para la fecha local
            episode_number: s.episode
        }));

        localStorage.setItem(cacheKey, JSON.stringify(dataAdaptada));
        renderizarHtmlCalendario(dataAdaptada);

    } catch (e) {
        console.error("Fallo al cargar calendario desde Anilist:", e); // Usamos console.error para errores reales
        if (!cachedData) {
            c.innerHTML = `
                <div style="text-align:center; padding:30px;">
                    <p style="color:#ff4444; margin-bottom:15px; font-size:0.8rem;">⚠️ ${e.message}</p>
                    <button onclick="cargarCalendario()" class="btn-random-gold">🔄 REINTENTAR CARGAR</button>
                </div>`;
        }
    }
}

function renderizarHtmlCalendario(data) {
    const c = document.getElementById('lista-calendario');
    if (!c) return;

    let html = `<div style="background: rgba(255, 215, 0, 0.1); border: 1px dashed var(--gold); padding: 10px; border-radius: 10px; margin-bottom: 20px; font-size: 0.75rem; text-align: center; color: var(--gold);">
        🚀 Radar Gold • Horarios en tu <strong>hora local</strong>.
    </div>`;

    if (!data || data.length === 0) {
        c.innerHTML = html + "<p style='text-align:center; opacity:0.5; padding:20px;'>No hay estrenos programados.</p>";
        return;
    }

    // 1. Agrupar los animes por día de la semana
    const grupos = {};
    data.forEach(a => {
        const d = new Date(a.airingAt * 1000);
        const diaNombre = d.toLocaleDateString('es-ES', { weekday: 'long' });
        const diaNum = d.getDate().toString().padStart(2, '0');
        const mesNum = (d.getMonth() + 1).toString().padStart(2, '0');
        const diaKey = `${diaNombre.charAt(0).toUpperCase() + diaNombre.slice(1)} ${diaNum}/${mesNum}`;
        
        if (!grupos[diaKey]) grupos[diaKey] = [];
        grupos[diaKey].push(a);
    });

    // 2. Generar el HTML con el sistema de acordeón
    Object.keys(grupos).forEach(dia => {
        const animes = grupos[dia];
        html += `
            <div class="dia-calendario-header" onclick="const list = this.nextElementSibling; list.style.display = list.style.display === 'none' ? 'block' : 'none'; this.querySelector('span').innerText = list.style.display === 'none' ? '${animes.length} ANIMES ▾' : '${animes.length} ANIMES ▴';" 
                 style="background:rgba(255,215,0,0.1); border:1px solid var(--gold); padding:15px; border-radius:12px; margin-bottom:10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
                <strong style="color:var(--gold); text-transform:uppercase; font-size:0.9rem; letter-spacing:1px;">📅 ${dia}</strong>
                <span style="color:var(--gold); font-size:0.7rem; font-weight:bold;">${animes.length} ANIMES ▾</span>
            </div>
            <div class="dia-calendario-lista" style="display:none; margin-bottom:20px; padding:0 5px;">`;
        
        animes.forEach(a => {
            const horaLocal = new Date(a.airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const animeJson = JSON.stringify(a).replace(/"/g, '&quot;').replace(/'/g, "&#39;");
            const tituloLimpio = a.title.replace(/'/g, "\\'").replace(/"/g, '&quot;');

            html += `
                <div class="calendario-item" onclick="showDetails(${animeJson})" style="background:var(--card); margin-bottom:8px; border-radius:15px; display:flex; padding:10px; align-items:center; cursor:pointer; border:1px solid rgba(255,215,0,0.05);">
                    <img src="${a.images.jpg.image_url}" width="45" style="border-radius:10px; margin-right:12px;">
                    <div style="flex:1;">
                        <strong style="font-size:0.85rem; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;">${a.title}</strong>
                        <small style="color:var(--gold); font-weight:bold;">${horaLocal} • Episodio ${a.episode_number}</small>
                    </div>
                    <button class="btn-notif" onclick="event.stopPropagation(); agendarNotificacionAnilist('${tituloLimpio}', '${a.images.jpg.image_url}', ${a.airingAt}, ${a.mal_id})" style="background:none; border:1px solid var(--gold); color:var(--gold); border-radius:10px; padding:5px 10px;">🔔</button>
                </div>
            `;
        });
        html += `</div>`;
    });

    c.innerHTML = html;
}

function agendarNotificacionAnilist(titulo, imagen, airingAt, animeId) {
    if (Notification.permission !== "granted") {
        return goldAlert({
            title: "NOTIFICACIONES",
            text: "Para avisarte de los estrenos, debes activar los permisos de notificación en tu navegador.",
            icon: "🔔",
            confirmText: "ENTENDIDO"
        });
    }
    
    const tiempoRestante = (airingAt * 1000) - Date.now();
    if (tiempoRestante <= 0) return goldAlert({ text: "Este episodio ya se emitió.", icon: "📺" });

    setTimeout(() => {
        lanzarNotificacionSistema("¡Estreno en AiduMe!", `¡Es hora! Ya salió: ${titulo}`, imagen, animeId);
    }, tiempoRestante);

    const horaLocal = new Date(airingAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    goldAlert({
        title: "RECORDATORIO FIJADO",
        text: `¡Listo! Te avisaremos cuando salga "${titulo}". En tu país se estrena a las ${horaLocal}.`,
        icon: "⏰",
        confirmText: "¡EXCELENTE!"
    });
}

async function irAnimeAzar() {
    try {
        const query = `
        query ($page: Int) {
            Page(page: $page, perPage: 1) {
                media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
                    id
                    idMal
                    title { romaji english native }
                    coverImage { extraLarge large medium }
                    description
                    episodes
                    status
                    averageScore
                    format
                    season
                    seasonYear
                    genres
                }
            }
        }`;
        
        // Página aleatoria entre 1 y 200 para obtener variedad
        const paginaRandom = Math.floor(Math.random() * 200) + 1;
        
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { page: paginaRandom } })
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        const media = json.data?.Page?.media?.[0];
        
        if (!media || !media.idMal) {
            throw new Error("Datos inválidos");
        }
        
        // Adaptar al formato que usa la app
        const anime = adaptAnilistToMALFormat([media])[0];
        showDetails(anime);
    } catch (e) {
        console.error("Error en anime aleatorio:", e.message);
        goldAlert({
            title: "ERROR",
            text: "No se pudo cargar un anime aleatorio. ¡Intenta de nuevo!",
            icon: "😿",
            confirmText: "INTENTAR DE NUEVO"
        });
    }
}
function hideDetails() { document.getElementById('details').style.display = "none"; }

async function cargarRelaciones(id) {
    const container = document.getElementById('anime-relations');
    
    try {
        // Pedimos a la API los detalles completos incluyendo relaciones
        const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/relations`);
        const json = await res.json();
        const data = json.data;

        container.innerHTML = ""; // Limpiamos el cargando

        // Buscamos específicamente "Prequel" y "Sequel"
        for (const rel of data) {
            if (rel.relation === "Prequel" || rel.relation === "Sequel") {
                for (const entry of rel.entry) {
                    const btn = document.createElement('div');
                    btn.className = 'relation-card';
                    const tipo = rel.relation === "Prequel" ? "⏪ Precuela" : "⏩ Secuela";
                    
                    // Obtenemos la imagen del anime relacionado
                    let imgUrl = 'placeholder.png';
                    try {
                        const imgRes = await fetch(`https://api.jikan.moe/v4/anime/${entry.mal_id}`);
                        const imgJson = await imgRes.json();
                        imgUrl = imgJson.data?.images?.jpg?.image_url || 'placeholder.png';
                    } catch (e) {
                        console.warn("No se pudo cargar imagen de relación:", entry.mal_id);
                    }
                    
                    btn.innerHTML = `
                        <img src="${imgUrl}" style="width:100%; height:120px; object-fit:cover; border-radius:8px; margin-bottom:5px;" loading="lazy">
                        <div style="font-size:0.7rem; color:var(--gold); font-weight:bold;">${tipo}</div>
                        <div style="font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${entry.name}</div>
                    `;
                    
                    // Al hacer clic, cargamos ese anime nuevo
                    btn.onclick = async () => {
                        container.innerHTML = "Cargando...";
                        const resp = await fetch(`https://api.jikan.moe/v4/anime/${entry.mal_id}`);
                        const nuevoAnime = await resp.json();
                        showDetails(nuevoAnime.data);
                    };
                    
                    container.appendChild(btn);
                }
            }
        }

        if (container.innerHTML === "") {
            container.innerHTML = "<p style='font-size:0.8rem; opacity:0.3;'>Sin precuelas o secuelas conocidas.</p>";
        }

    } catch (err) {
        console.error("Error cargando relaciones:", err);
        container.innerHTML = "";
    }
}

// En api.js
async function limpiarHistorialUsuario() {
    if (!currentUser) return; 

    // --- REEMPLAZO DEL CONFIRM POR GOLD ALERT (ADVERTENCIA SERIA) ---
    const confirmar = await goldAlert({
        title: "BORRAR HISTORIAL",
        text: "¿Estás seguro de que quieres borrar TODO tu historial de vistos? Esta acción no se puede deshacer.",
        icon: "🗑️",
        showCancel: true,
        confirmText: "SÍ, BORRAR TODO"
    });
    
    if (confirmar) {
        try {
            // Ejecutamos el borrado filtrando por el nombre del usuario actual
            const { error } = await _db
                .from('vistos')
                .delete()
                .ilike('usuario_nombre', currentUser);

            if (error) throw error;

            // --- REEMPLAZO DEL ALERT POR GOLD ALERT (ÉXITO) ---
            goldAlert({
                title: "HISTORIAL LIMPIO",
                text: "Tu historial ha sido eliminado correctamente de nuestros registros.",
                icon: "🧹",
                confirmText: "ENTENDIDO"
            });
            
            // Refrescamos la lista en la pantalla
            if (typeof cargarListaDesdeSQL === 'function') {
                cargarListaDesdeSQL('vistos', 'lista-historial', 'fecha_visto');
            }

        } catch (err) {
            console.error("Error al limpiar historial:", err.message);
            
            // --- REEMPLAZO DEL ALERT POR GOLD ALERT (ERROR) ---
            goldAlert({
                title: "ERROR",
                text: "No se pudo limpiar el historial. Verifica tu conexión e intenta de nuevo.",
                icon: "❌"
            });
        }
    }
}

// NUEVA FUNCIÓN PARA GUARDAR EN LA NUBE
async function checkUserRating(animeId) {
    if (!currentUser) return;
    
    try {
        // Consultamos si el usuario actual ya valoró este anime específico
        const { data, error } = await _db
            .from('valoraciones')
            .select('estrellas')
            .ilike('usuario_nombre', currentUser)
            .eq('anime_id', animeId)
            .maybeSingle();

        if (error) throw error;

        if (data) {
            // Si hay voto en la DB, mostramos sus estrellas y bloqueamos
            updateStars(data.estrellas, true);
        } else {
            // Si NO hay voto, limpiamos las estrellas (0) y desbloqueamos (false)
            updateStars(0, false);
        }
    } catch (err) {
        console.error("Error al verificar calificación:", err.message);
        // Por seguridad, si falla la red, reseteamos a 0 para no mostrar votos ajenos
        updateStars(0, false);
    }
}

// Al final de api.js
const GENRES_LIST = [
    { id: 1, name: "Acción" }, { id: 2, name: "Aventuras" },
    { id: 4, name: "Comedia" }, { id: 8, name: "Drama" },
    { id: 10, name: "Fantasía" }, { id: 14, name: "Terror" },
    { id: 7, name: "Misterio" }, { id: 22, name: "Romance" },
    { id: 24, name: "Sci-Fi" }, { id: 36, name: "Recuentos de la vida" },
    { id: 37, name: "Sobrenatural" }, { id: 41, name: "Suspenso" }
];

// Lista de géneros de Anilist (strings en lugar de IDs numéricos de Jikan)
const GENRES_FLV = [
    { id: "Action", name: "Acción" }, 
    { id: "Adventure", name: "Aventuras" }, 
    { id: "Comedy", name: "Comedia" },
    { id: "Drama", name: "Drama" }, 
    { id: "Fantasy", name: "Fantasía" }, 
    { id: "Mystery", name: "Misterio" },
    { id: "Romance", name: "Romance" }, 
    { id: "Supernatural", name: "Sobrenatural" }, 
    { id: "Thriller", name: "Suspenso" }
];

function cargarGenerosEnPanel() {
    const select = document.getElementById('filter-genre-select');
    if (!select) return;
    
    GENRES_FLV.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id; // Guarda el string de Anilist (ej: "Action", "Comedy")
        opt.innerText = g.name;
        select.appendChild(opt);
    });
}

async function aplicarFiltrosAvanzados(pagina = 1) {
    // Obtenemos los valores de los nuevos selectores
    paginaFiltros = pagina;
    const genre = document.getElementById('filter-genre-select').value;
    const status = document.getElementById('filter-status').value;
    const order = document.getElementById('filter-order').value;
    
    // 1. Referencias a los contenedores principales
    const seccionTop10 = document.getElementById('seccion-top-10');
    const seccionRecientes = document.getElementById('seccion-ultimos-episodios');
    const paginacionNormal = document.getElementById('paginacion-container');
    const listaTodos = document.getElementById('lista-todos');

    const headerTodos = listaTodos ? listaTodos.previousElementSibling : null;
    const tituloTodos = headerTodos ? headerTodos.querySelector('.section-h') : null;

    // 2. Ocultamos las secciones destacadas para que no estorben
    if (seccionTop10) seccionTop10.style.display = 'none';
    if (seccionRecientes) seccionRecientes.style.display = 'none';
    if (paginacionNormal) paginacionNormal.style.display = 'none';

    // 3. Estilo Gold para el título y cargador
    if (tituloTodos) {
        tituloTodos.innerHTML = `✨ RESULTADOS DEL RADAR GOLD`;
        tituloTodos.style.color = 'var(--gold)';
    }

    if (listaTodos) {
        listaTodos.innerHTML = `
            <div style="width:100%; text-align:center; padding:60px 20px; animation: slideUp 0.5s ease;">
                <div style="font-size:3rem; margin-bottom:20px; animation: pulseGold 1.5s infinite;">🔍</div>
                <p style="color:var(--gold); font-weight:900; letter-spacing:2px; text-transform:uppercase; font-size:0.75rem;">
                    Sincronizando con la Base de Datos Maestra...
                </p>
            </div>`;
    }

    // Mapeo de estados de Jikan a Anilist
    const statusMap = {
        'airing': 'RELEASING',
        'complete': 'FINISHED'
    };
    
    // Mapeo de ordenamiento de Jikan a Anilist
    const orderMap = {
        'score': 'SCORE_DESC',
        'popularity': 'POPULARITY_DESC',
        'ranked': 'RANKING'
    };
    
    const anilistStatus = status ? statusMap[status] : null;
    const anilistSort = orderMap[order] || 'POPULARITY_DESC';
    
    // Construir consulta GraphQL para Anilist
    let graphqlQuery = `
    query ($page: Int, $perPage: Int, $sort: [MediaSort], $status: MediaStatus, $genre: String) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: $sort, status: $status, genre: $genre) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large medium }
          description
          episodes
          status
          averageScore
          format
          season
          seasonYear
          genres
        }
        pageInfo {
          total
          perPage
          currentPage
          lastPage
          hasNextPage
        }
      }
    }`;
    
    const variables = {
        page: paginaFiltros,
        perPage: 24,
        sort: anilistSort
    };
    
    if (anilistStatus) variables.status = anilistStatus;
    if (genre) variables.genre = genre;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const r = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: graphqlQuery, variables }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!r.ok) throw new Error(`Error HTTP ${r.status}: La API de Anilist no respondió.`);

        const j = await r.json();

        if (j.data?.Page?.media && j.data.Page.media.length > 0) {
            const adaptedData = adaptAnilistToMALFormat(j.data.Page.media);
            renderGrid(adaptedData, 'lista-todos');
            renderPaginacionFiltros(j.data.Page.pageInfo);
        } else {
            if (listaTodos) {
                listaTodos.innerHTML = `
                    <div style="text-align:center; padding:40px; width:100%;">
                        <p style="opacity:0.5; color:#888;">No se detectaron animes con esos filtros.</p>
                        <button onclick="aplicarFiltrosAvanzados(1)" class="btn-random-gold" style="margin-top:20px;">🔄 REINTENTAR</button>
                    </div>`;
            }
        }

        const pBusquedaExistente = document.getElementById('paginacion-busqueda');
        if (pBusquedaExistente) pBusquedaExistente.remove();
        const pNormalExistente = document.getElementById('paginacion-container');
        if (pNormalExistente) pNormalExistente.style.display = 'none';
    } catch (e) {
        console.error("Error al filtrar:", e);
        
        const errorMsg = e.name === 'AbortError' 
            ? 'La conexión con la biblioteca tardó demasiado. Verifica tu internet.'
            : e.message || 'No pudimos conectar con la biblioteca central.';
        
        if (listaTodos) {
            listaTodos.innerHTML = `
                <div style="width:100%; text-align:center; padding:40px 20px;">
                    <div style="font-size:2.5rem; margin-bottom:15px;">⚠️</div>
                    <p style="color:#ff6b6b; font-size:0.85rem; margin-bottom:15px;">${errorMsg}</p>
                    <button onclick="aplicarFiltrosAvanzados(1)" class="btn-random-gold" style="margin:5px;">🔄 REINTENTAR</button>
                </div>`;
        }
        
        goldAlert({
            title: "FALLO EN EL RADAR",
            text: errorMsg,
            icon: "❌"
        });
    }
}

function renderPaginacionFiltros(info) {
    let contenedorFiltros = document.getElementById('paginacion-filtros');
    if (contenedorFiltros) contenedorFiltros.remove();

    // Estructura de Anilist: hasNextPage, currentPage, lastPage
    const hasNextPage = info.hasNextPage;
    const currentPage = info.currentPage || paginaFiltros;
    const lastPage = info.lastPage;

    if (!hasNextPage && currentPage === 1) return;

    contenedorFiltros = document.createElement('div');
    contenedorFiltros.id = 'paginacion-filtros';
    contenedorFiltros.style = "display: flex; justify-content: center; align-items: center; gap: 20px; margin: 30px 0; padding-bottom: 20px;";

    contenedorFiltros.innerHTML = `
        <button onclick="aplicarFiltrosAvanzados(${currentPage - 1})" class="btn-random-gold" ${currentPage === 1 ? 'disabled style="opacity:0.5"' : ''}>❮ Anterior</button>
        <span style="color: var(--gold); font-weight: bold; font-size: 1.1rem;">Página ${currentPage} de ${lastPage || '?'}</span>
        <button onclick="aplicarFiltrosAvanzados(${currentPage + 1})" class="btn-random-gold" ${!hasNextPage ? 'disabled style="opacity:0.5"' : ''}>Siguiente ❯</button>
    `;

    document.getElementById('lista-todos').after(contenedorFiltros);
}

let paginaBusqueda = 1; // Variable global para controlar la página de búsqueda

async function buscarAnimeLive(pagina = 1) {
    paginaBusqueda = pagina;
    const q = document.getElementById('busqueda').value.trim();
    
    // Referencias a tus elementos
    const seccionTop10 = document.getElementById('seccion-top-10');
    const paginacionNormal = document.getElementById('paginacion-container');
    const titulos = document.querySelectorAll('.section-h');
    const tituloTodos = titulos[1] ? titulos[1] : null;

    // Si el buscador está vacío, volvemos a la normalidad
    if (q.length === 0) {
        if (seccionTop10) seccionTop10.style.display = 'block';
        if (paginacionNormal) paginacionNormal.style.display = 'flex';
        if (tituloTodos) tituloTodos.innerText = "Todos los Animes";
        
        // Eliminamos los botones de paginación de búsqueda si existen
        const pBusquedaExistente = document.getElementById('paginacion-busqueda');
        if (pBusquedaExistente) pBusquedaExistente.remove();
        const pFiltrosExistente = document.getElementById('paginacion-filtros');
        if (pFiltrosExistente) pFiltrosExistente.remove();

        return cargarHome(); 
    }

    // --- ESTADO: BUSCANDO ---
    if (seccionTop10) seccionTop10.style.display = 'none';
    if (paginacionNormal) paginacionNormal.style.display = 'none';
    
    const pFiltrosExistente = document.getElementById('paginacion-filtros');
    if (pFiltrosExistente) pFiltrosExistente.remove();

    if (tituloTodos) tituloTodos.innerText = `Resultados para: "${q}" (Pág. ${paginaBusqueda})`;

    // Fetch a Jikan: order_by=popularity & sort=asc (para que el #1 sea el primero)
    try {
        const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&order_by=popularity&sort=asc&page=${paginaBusqueda}`);
        const j = await response.json();
        
        if (j.data) {
            // Renderizamos en tu grilla principal
            renderGrid(j.data, 'lista-todos');
            
            // Creamos o actualizamos los botones de paginación de la búsqueda
            renderPaginacionBusqueda(j.pagination);
        }
    } catch (err) {
        console.error("Error en búsqueda en vivo:", err);
    }
}

// Función auxiliar para renderizar la paginación de resultados
function renderPaginacionBusqueda(info) {
    // Eliminamos la paginación de búsqueda anterior si existe
    let contenedorBusqueda = document.getElementById('paginacion-busqueda');
    if (contenedorBusqueda) contenedorBusqueda.remove();

    // Solo mostramos paginación si hay más de una página o no estamos en la 1
    if (!info.has_next_page && paginaBusqueda === 1) return;

    contenedorBusqueda = document.createElement('div');
    contenedorBusqueda.id = 'paginacion-busqueda';
    contenedorBusqueda.style = "display: flex; justify-content: center; align-items: center; gap: 20px; margin: 30px 0; padding-bottom: 20px;";

    contenedorBusqueda.innerHTML = `
        <button onclick="buscarAnimeLive(${paginaBusqueda - 1})" class="btn-random-gold" ${paginaBusqueda === 1 ? 'disabled style="opacity:0.5"' : ''}>❮ Anterior</button>
        <span style="color: var(--gold); font-weight: bold; font-size: 1.1rem;">Página ${paginaBusqueda}</span>
        <button onclick="buscarAnimeLive(${paginaBusqueda + 1})" class="btn-random-gold" ${!info.has_next_page ? 'disabled style="opacity:0.5"' : ''}>Siguiente ❯</button>
    `;

    // Insertamos la paginación después de la lista de resultados
    document.getElementById('lista-todos').after(contenedorBusqueda);
}

// Función para borrar cualquier comentario (Solo Admin)
async function borrarComentarioAdmin(comentarioId) {
    // --- REEMPLAZO DEL CONFIRM POR GOLD ALERT ---
    const confirmar = await goldAlert({
        title: "ELIMINAR COMENTARIO",
        text: "¿Estás seguro de que deseas borrar este comentario permanentemente? Esta acción no se puede deshacer.",
        icon: "🗑️",
        showCancel: true,
        confirmText: "SÍ, ELIMINAR"
    });

    if (!confirmar) return;
    
    try {
        const { error } = await _db.from('comentarios').delete().eq('id', comentarioId);
        
        if (error) throw error;

        // --- REEMPLAZO DEL ALERT POR GOLD ALERT (ÉXITO) ---
        goldAlert({
            title: "ELIMINADO",
            text: "El comentario ha sido removido de la base de datos con éxito.",
            icon: "✔️",
            confirmText: "CONTINUAR"
        });

        // Recarga la lista del panel
        if (typeof cargarComentariosAdmin === 'function') {
            cargarComentariosAdmin(); 
        }

    } catch (err) {
        console.error("Error al borrar:", err.message);
        goldAlert({
            title: "ERROR",
            text: "No se pudo eliminar el comentario. Inténtalo de nuevo.",
            icon: "❌"
        });
    }
}

// Función para suspender o banear
// Nueva función para manejar el tiempo dinámico
async function suspenderUsuarioDinamico() {
    const user = document.getElementById('admin-search-user').value.trim();
    const horasInput = document.getElementById('admin-suspend-hours').value;
    
    if (!user) return goldAlert({ title: "CAMPOS VACÍOS", text: "Escribe un nombre de usuario para sancionar.", icon: "👤" });
    if (!horasInput || horasInput <= 0) return goldAlert({ title: "TIEMPO INVÁLIDO", text: "Indica una cantidad de horas válida.", icon: "⏳" });

    const horas = parseFloat(horasInput);
    await aplicarSancion(user, horas);
}

// Función principal de sanción actualizada
async function aplicarSancion(user, horas) {
    try {
        const { data: moderador } = await _db.from('perfiles').select('rol').ilike('nombre', currentUser).single();
        const { data: objetivo } = await _db.from('perfiles').select('rol, sancion_motivo').ilike('nombre', user).single();

        if (!objetivo) return goldAlert({ title: "ERROR", text: "El usuario objetivo no existe en la base de datos.", icon: "❌" });

        // --- LÓGICA DE PROTECCIÓN DEL DUEÑO ---
        if (objetivo.rol === 'dueño') {
            if (moderador.rol === 'admin') {
                const fechaKarma = new Date('2099-01-01').toISOString();
                await _db.from('perfiles').update({ 
                    baneado_hasta: fechaKarma,
                    sancion_motivo: `Traición: ${currentUser} intentó banear al DUEÑO`
                }).ilike('nombre', currentUser);
                
                await goldAlert({ 
                    title: "TRAICIÓN DETECTADA", 
                    text: `⚠️ ${currentUser}, has intentado banear al DUEÑO. El sistema ha respondido: Ahora TÚ estás baneado permanentemente.`, 
                    icon: "⚡",
                    confirmText: "ACEPTAR MI DESTINO"
                });
                location.reload(); 
                return;
            }
            return goldAlert({ title: "SISTEMA REAL", text: "👑 El Dueño es intocable.", icon: "👑" });
        }

        // --- SI EL MODERADOR INTENTA UN BAN PERMANENTE (horas=0), SE LO DENEGAMOS ---
        const esModerador = (moderador.rol === 'moderador');
        const esPermanente = (horas === 0);

        if (esModerador && esPermanente) {
            return goldAlert({ 
                title: "ACCESO DENEGADO", 
                text: "🔍 Los Moderadores solo pueden SUSPENDER temporalmente, no pueden aplicar baneos permanentes. Solicita a un Administrador o Dueño si es necesario.", 
                icon: "🚫" 
            });
        }

        // --- LÓGICA DE SANCIÓN NORMAL ---
        let fechaBaneo = null;

        if (!esPermanente) {
            fechaBaneo = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();
        } else {
            fechaBaneo = new Date('2099-01-01').toISOString(); 
        }

        // --- PEDIR MOTIVO ANTES DE CONFIRMAR ---
        const motivo = await goldAlert({
            title: "MOTIVO DE LA SANCIÓN",
            text: `Escribe el motivo por el cual ${esPermanente ? 'baneas permanentemente' : 'suspendes por ' + horas + 'h'} a @${user}.\n\nEste motivo quedará registrado y visible para el equipo de moderación.`,
            icon: "📝",
            showInput: true,
            showCancel: true,
            confirmText: "CONTINUAR"
        });

        if (!motivo || motivo.trim().length < 4) {
            if (motivo !== null) {
                goldAlert({ title: "MOTIVO INVÁLIDO", text: "Debes escribir un motivo descriptivo (mín. 4 caracteres).", icon: "✍️" });
            }
            return;
        }

        // Confirmación antes de ejecutar
        const confirmar = await goldAlert({
            title: "CONFIRMAR SANCIÓN",
            text: `¿Estás seguro de que quieres ${esPermanente ? 'BANEAR PERMANENTEMENTE' : 'SUSPENDER'} a @${user}?\n\nMotivo: ${motivo.trim()}`,
            icon: "⚖️",
            showCancel: true,
            confirmText: "SÍ, EJECUTAR"
        });

        if (!confirmar) return;

        const { error } = await _db
            .from('perfiles')
            .update({ 
                baneado_hasta: fechaBaneo,
                sancion_motivo: motivo.trim(),
                sancion_por: currentUser.trim(),
                sancion_fecha: new Date().toISOString()
            })
            .ilike('nombre', user);

        if (error) throw error;
        
        goldAlert({ 
            title: "SENTENCIA APLICADA", 
            text: `El usuario @${user} ha sido ${esPermanente ? 'expulsado permanentemente' : 'suspendido por ' + horas + 'h'}.\nMotivo: ${motivo.trim()}`, 
            icon: "🔨" 
        });
        
    } catch (err) {
        console.error("Error al sancionar:", err.message);
        goldAlert({ title: "ERROR", text: "No se pudo aplicar la sanción correctamente.", icon: "❌" });
    }
}

// Mantén esta para el botón de Ban Permanente (que envía 0)
async function suspenderUsuario(horas) {
    const user = document.getElementById('admin-search-user').value.trim();
    if (!user) return goldAlert({ title: "NOMBRE REQUERIDO", text: "Escribe un nombre para aplicar el ban permanente.", icon: "🔍" });
    await aplicarSancion(user, horas);
}

async function cargarComentariosAdmin() {
    const list = document.getElementById('admin-lista-comentarios');
    if (!list) return;

    list.innerHTML = "<p style='text-align:center; opacity:0.5; font-size:0.8rem;'>Analizando y agrupando todos los reportes...</p>";

    try {
        // 1. TRAEMOS TODOS LOS REPORTES NO REVISADOS DE LA TABLA ÚNICA
        const { data: todosLosReportes, error } = await _db
            .from('reportes')
            .select('*')
            .eq('revisado', false)
            .order('fecha', { ascending: false });

        if (error) throw error;

        list.innerHTML = "";

        if (!todosLosReportes || todosLosReportes.length === 0) {
            list.innerHTML = "<p style='text-align:center; opacity:0.5;'>No hay reportes de ningún tipo.</p>";
            return;
        }

        // Separamos los reportes de episodios de los de chat/comentario
        const reportesEpisodios = todosLosReportes.filter(r => r.tipo === 'episodio');
        const reportesSociales = todosLosReportes.filter(r => r.tipo === 'comentario' || r.tipo === 'chat'); // Por si manejas tipo 'chat' explícito

        // --- A. RENDERIZADO DE REPORTES DE EPISODIOS (VERDES) ---
        if (reportesEpisodios.length > 0) {
            reportesEpisodios.forEach(r => {
                const divEp = document.createElement('div');
                divEp.id = `reporte-verde-${r.id}`; 
                
                divEp.style = "margin-bottom: 15px; padding: 15px; border-radius: 12px; background: rgba(0, 255, 100, 0.08); border: 1px solid #00ff64;";
                divEp.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                <span style="color:#00ff64; font-size:0.7rem; font-weight:900;">⚠️ VIDEO CAÍDO</span>
                                <span style="background:#00ff64; color:black; font-size:0.6rem; padding:2px 6px; border-radius:4px; font-weight:bold; text-transform: uppercase;">
                                    ${r.idioma || 'Subtitulado'}
                                </span>
                                <span style="color:#fff; font-size:0.8rem; font-weight:bold;">${r.anime_nombre}</span>
                            </div>
                            <p style="color:#eee; margin: 3px 0; font-size: 0.9rem;">
                                Falla detectada en el <strong>Episodio ${r.episodio}</strong>.
                            </p>
                            <p style="font-size:0.7rem; opacity:0.5;">Reportado por: @${r.usuario_reporta} | ID: ${r.anime_id}</p>
                        </div>
                        <!-- Ahora llamamos a borrarGrupoReportes pasándole el ID en un array para marcarlo como revisado -->
                        <button onclick="borrarGrupoReportes([${r.id}])" title="Marcar como arreglado"
                                style="background:rgba(0, 255, 100, 0.2); border:1px solid #00ff64; color:white; border-radius:8px; padding:10px; cursor:pointer; font-size:1.1rem;">
                            ✔️
                        </button>
                    </div>`;
                list.appendChild(divEp);
            });
        }

        // --- B. LÓGICA DE AGRUPACIÓN PARA CHAT Y COMENTARIOS ---
        if (reportesSociales.length > 0) {
            const grupos = {};
            for (const r of reportesSociales) {
                // Detectar si es chat (ya sea por el flag 'tipo' o la marca morada en el motivo)
                const esChat = r.tipo === 'chat' || (r.motivo && r.motivo.includes('[CHAT_PURPLE]')) || !r.comentario_id;

                let llaveGrupo;
                if (esChat && r.motivo) {
                    const matchUser = r.motivo.match(/\(Usuario:\s*([^)]+)\)/);
                    const userReportado = matchUser ? matchUser[1].trim().toLowerCase() : "desconocido";
                    llaveGrupo = `chat_u_${userReportado}`;
                } else {
                    llaveGrupo = esChat ? "chat_sin_info" : `anime_${r.comentario_id}`;
                }

                if (!grupos[llaveGrupo]) {
                    grupos[llaveGrupo] = {
                        infoBase: r,
                        denunciantes: [r.usuario_reporta],
                        cantidad: 1,
                        esChat: esChat,
                        idsParaBorrar: [r.id]
                    };
                } else {
                    grupos[llaveGrupo].cantidad++;
                    if (!grupos[llaveGrupo].denunciantes.includes(r.usuario_reporta)) {
                        grupos[llaveGrupo].denunciantes.push(r.usuario_reporta);
                    }
                    grupos[llaveGrupo].idsParaBorrar.push(r.id);
                }
            }

            for (const key in grupos) {
                const grupo = grupos[key];
                const r = grupo.infoBase;
                let usuarioObjetivo = "Usuario Desconocido";
                let textoReportado = "Mensaje en vivo";

                if (grupo.esChat) {
                    const matchUser = r.motivo.match(/\(Usuario:\s*([^)]+)\)/);
                    usuarioObjetivo = matchUser ? `@${matchUser[1].trim()}` : "Usuario del Chat";
                    const matchMsj = r.motivo.match(/Mensaje:\s*"([^"]+)"/);
                    textoReportado = matchMsj ? `"${matchMsj[1]}"` : "Mensaje original no capturado";
                } else if (r.comentario_id) {
                    const { data: comData } = await _db
                        .from('comentarios')
                        .select('usuario, comentario')
                        .eq('id', r.comentario_id)
                        .maybeSingle();

                    if (comData) {
                        usuarioObjetivo = `@${comData.usuario}`;
                        textoReportado = `"${comData.comentario}"`;
                    } else {
                        textoReportado = "Comentario ya eliminado";
                    }
                }

                const d = document.createElement('div');
                if (grupo.esChat) {
                    d.style = "margin-bottom: 15px; padding: 15px; border-radius: 12px; background: rgba(128, 0, 128, 0.15); border: 1px solid #a020f0;";
                } else {
                    d.style = "margin-bottom: 15px; padding: 15px; border-radius: 12px; background: rgba(229, 9, 20, 0.12); border: 1px solid #e50914;";
                }

                const motivoLimpio = r.motivo ? r.motivo.replace(/\[CHAT_PURPLE\]/g, '💜 CHAT:').replace(/Motivo:\s*/, '').replace(/| Mensaje:\s*"[^"]*"/, '').replace(/\(Usuario:\s*[^)]+\)/g, '').trim() : "Sin descripción";
                const listaDenunciantes = grupo.denunciantes.map(u => `@${u}`).join(', ');

                d.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                <span style="color:var(--gold); font-size:0.7rem; font-weight:900;">
                                    ${grupo.esChat ? '💜 REPORTE DE CHAT' : '🚨 REPORTE DE COMENTARIO'} (${grupo.cantidad})
                                </span>
                                <span style="color:rgba(255,255,255,0.4); font-size:0.7rem;">|</span>
                                <span style="color:#fff; font-size:0.75rem; font-weight:bold;">${usuarioObjetivo}</span>
                            </div>
                            <p style="color:#eee; margin: 5px 0; font-size: 0.9rem; font-style: italic; opacity:0.8;">
                                ${textoReportado}
                            </p>
                            <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.3); border-radius: 6px; font-size: 0.75rem;">
                                <strong style="color:var(--gold);">Denunciantes:</strong> ${listaDenunciantes}<br>
                                <strong style="color:var(--gold);">Último motivo:</strong> ${motivoLimpio || 'Sin descripción adicional'}
                            </div>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:5px;">
                            <button onclick="borrarGrupoReportes([${grupo.idsParaBorrar}])" title="Marcar como revisado"
                                    style="background:rgba(255,255,255,0.1); border:1px solid #666; color:white; border-radius:8px; padding:8px; cursor:pointer;">✔️</button>
                            ${!grupo.esChat ? `<button onclick="borrarComentarioAdmin(${r.comentario_id})" style="background:rgba(255,68,68,0.1); border:1px solid #ff4444; color:#ff4444; border-radius:8px; padding:8px; cursor:pointer;">🗑️</button>` : ''}
                        </div>
                    </div>`;
                list.appendChild(d);
            }
        }

    } catch (err) {
        console.error("Error Admin:", err.message);
        list.innerHTML = `<p style='color:red; text-align:center;'>Error al cargar el panel: ${err.message}</p>`;
    }
}

/*async function borrarReporteEpisodio(id) {
    console.log("Intentando borrar el reporte ID:", id);
    
    try {
        const { error } = await _db
            .from('reportes_episodios')
            .delete()
            .eq('id', id);

        if (error) {
            alert("Error de Supabase: " + error.message);
            console.error(error);
            return;
        }

        alert("¡Reporte borrado de la base de datos!");
        
        // Esto vuelve a ejecutar la función que limpia la lista y la redibuja
        await cargarComentariosAdmin(); 

    } catch (err) {
        alert("Error crítico: " + err.message);
    }
}*/

window.borrarReporteEpisodio = async function(id) {
    const confirmar = await goldAlert({
        title: "CONFIRMAR",
        text: "¿Estás seguro de marcar este reporte como arreglado?",
        icon: "❓",
        showCancel: true,
        confirmText: "SÍ, BORRAR"
    });

    if (!confirmar) return;

    try {
        // Usamos DELETE en lugar de update({ revisado: true }) porque la tabla
        // reportes_episodios NO tiene columna 'revisado'. Al eliminar el registro
        // directamente, garantizamos que desaparezca del panel de administración.
        const { error } = await _db.from('reportes_episodios').delete().eq('id', id);
        if (!error) {
            goldAlert({ title: "REVISADO", text: "El reporte se ha marcado como resuelto.", icon: "✔️" });
            cargarComentariosAdmin();
        } else {
            console.error("Error al eliminar reporte:", error);
            goldAlert({ title: "ERROR", text: "No se pudo eliminar el reporte. Intenta de nuevo.", icon: "❌" });
        }
    } catch (e) { console.error(e); }
};

// Asegúrate de que sea global si usas type="module"
window.borrarGrupoReportes = async function(ids) {
    // 1. Log de control
    console.log("Intentando borrar IDs:", ids);
    
    // 2. Validación básica
    if (!ids || ids.length === 0) {
        console.error("No se pasaron IDs para borrar.");
        return;
    }

    try {
        const { error } = await _db
            .from('reportes')
            .update({ revisado: true })
            .in('id', ids);

        if (error) {
            // Si Supabase devuelve error, lo mostramos con goldAlert
            console.error("Error de Supabase:", error.message);
            await goldAlert({
                title: "ERROR AL MODERAR",
                text: "Ocurrió un problema en la base de datos: " + error.message,
                icon: "⚠️"
            });
            return;
        }

        // 3. Feedback visual de éxito con tu sistema de alertas
        console.log("Borrado exitoso.");
        await goldAlert({
            title: "REPORTES LIMPIADOS",
            text: "Los reportes seleccionados han sido marcados como revisados con éxito.",
            icon: "🧹"
        });
        
        // 4. Recarga la lista
        await cargarComentariosAdmin();

    } catch (err) {
        // Errores de red o de código
        console.error("Error crítico en la función:", err);
        await goldAlert({
            title: "ERROR CRÍTICO",
            text: "No se pudo completar la operación de moderación debido a un fallo inesperado.",
            icon: "❌"
        });
    }
};

/*// Nueva función para borrar el grupo completo de una vez
async function borrarGrupoReportes(ids) {
    const { error } = await _db.from('reportes').delete().in('id', ids);
    if (!error) {
        cargarComentariosAdmin();
    }
}*/

// Función auxiliar para el botón Ver más / Ver menos
function toggleMotivos(btn, id, todos, cortos) {
    const div = document.getElementById(`motivos-${id}`);
    if (btn.innerText === "Ver más...") {
        div.innerHTML = todos;
        btn.innerText = "Ver menos";
    } else {
        div.innerHTML = cortos;
        btn.innerText = "Ver más...";
    }
}

function contieneOfensa(texto) {
    if (!texto) return false;

    // 1. Expresión regular para detectar CUALQUIER tipo de enlace/URL
    const regexLinks = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.(com|net|org|edu|gov|mil|co|biz|info|me|tv|io|cl|ar|uy|br|ru|ly|gl)(?:\/[^\s]*)?)/gi;
    
    if (regexLinks.test(texto)) {
        return true; 
    }

    // 2. Lista masiva y ampliada de ofensas
    const palabras = [
        // --- Insultos Argentinos y del Cono Sur ---
        "boludo", "boluda", "pelotudo", "pelotuda", "conchudo", "conchuda", "concha",
        "forro", "forra", "puto", "puta", "trolazo", "trolo", "trola", "orto", "ojete",
        "pajero", "pajera", "paja", "culiado", "culiada", "culia", "culio", "chupala",
        "mame", "mamar", "pendejo", "pendeja", "mierda", "cagar", "cagada", "bosta",
        "marica", "maricon", "cabron", "cabrona", "pito", "verga", "pija", "carajo",
        "pijudo", "conchita", "chupaverga", "chupapija", "mameitor", "forrito", "gato",
        "reputa", "malparido", "malparida", "pajaron", "forrada", "mamerto", "mamerta",

        // --- Insultos Internacionales / Latam / España ---
        "gilipollas", "coño", "joder", "chinga", "chingar", "chingada", "chingado",
        "pendejada", "culero", "culera", "mariconazo", "gonorrea", "parce", "carechimba",
        "hijo de puta", "hija de puta", "hdp", "la tuya", "concha de tu madre", "concha de tu hermana",
        "putita", "putito", "zorra", "perra", "bastardo", "bastarda", "tarado", "tarada",
        "imbecil", "estupido", "estupida", "idiota", "bobolo", "pendejito", "pendejita",

        // --- Toxicidad en Comunidades, Gaming y Anime (Descalificaciones y Discriminación) ---
        "mogolico", "mogolica", "retrasado", "retrasada", "enfermo", "enferma", 
        "autista", "gordo", "gorda", "negro de", "negra de", "autismo", "cancer",
        "down", "sindrome", "fracasado", "fracasada", "virgo", "virgacho", "gordofobico",
        "topo", "manco", "manca", "pt", "pt de mierda", "bobito", "bobita", "lloron",
        "llorona", "rata", "niño rata", "subnormal", "mongol", "mongolico", "mongolica",

        // --- Spam / Promoción / Estafas ---
        "seguime en", "mi canal", "mi instagram", "mi twitch", "mi tiktok", 
        "suscribite", "gana plata", "gana dinero", "hacerse rico", "casino", "apuestas",
        "telegram", "grupo de", "escribime", "hablame al", "ganancias", "inverti"
    ];

    // 3. Tu lógica de espaciado (vuelve inmune el filtro a "p.u.t.o", "b_o_l_u_d_o", etc.)
    return palabras.some(p => {
        const patron = p.split('').join('[\\s\\.\\-\\_]*');
        const regex = new RegExp(patron, 'gi');
        return regex.test(texto);
    });
}

async function reportarComentario(comId) {
    if (!currentUser) {
        return goldAlert({ 
            title: "INICIA SESIÓN", 
            text: "Debes estar logueado para reportar comentarios.", 
            icon: "👤" 
        });
    }

    // 1. Advertencia previa
    const advertencia = await goldAlert({
        title: "AVISO DE MODERACIÓN",
        text: "Reportar comentarios sin un motivo válido o de forma malintencionada puede resultar en la SUSPENSIÓN de tu cuenta.\n\n¿Estás seguro de que este comentario infringe las normas?",
        icon: "⚠️",
        showCancel: true,
        confirmText: "ESTOY SEGURO"
    });

    if (!advertencia) return;

    try {
        // 2. Verificar si ya reportó este comentario específico
        const { data: yaReportado, error: errCheck } = await _db
            .from('reportes')
            .select('id')
            .eq('tipo', 'comentario')
            .eq('comentario_id', comId)
            .ilike('usuario_reporta', currentUser)
            .maybeSingle();

        if (errCheck) throw errCheck;

        if (yaReportado) {
            return goldAlert({ 
                title: "REPORTE DUPLICADO", 
                text: "Ya has enviado un reporte para este comentario anteriormente.", 
                icon: "📂" 
            });
        }

        // 3. Pedir motivo
        const motivo = await goldAlert({
            title: "SISTEMA DE MODERACIÓN",
            text: `Escribe el motivo del reporte.\n\n(Tu usuario @${currentUser} quedará vinculado a este reporte).`,
            icon: "🛡️",
            showInput: true,
            showCancel: true,
            confirmText: "ENVIAR REPORTE"
        });
        
        if (!motivo || motivo.trim().length < 4) {
            if (motivo !== null) {
                goldAlert({ 
                    title: "MOTIVO INVÁLIDO", 
                    text: "Debes proporcionar un motivo descriptivo para proceder.", 
                    icon: "✍️" 
                });
            }
            return;
        }

        // 4. Insertar en Supabase indicando que es tipo 'comentario'
        const { error: errInsert } = await _db.from('reportes').insert([{
            tipo: 'comentario',
            comentario_id: comId,
            usuario_reporta: currentUser,
            motivo: motivo.trim(),
            fecha: new Date().toISOString()
        }]);

        if (errInsert) throw errInsert;

        goldAlert({
            title: "REPORTE RECIBIDO",
            text: "Gracias por ayudar a mantener AiduMe seguro. Nuestro equipo revisará el comentario pronto.",
            icon: "✔️",
            confirmText: "ENTENDIDO"
        });
        
        if (typeof cargarComentariosAdmin === 'function') cargarComentariosAdmin();

    } catch (err) {
        console.error("Error al reportar comentario:", err.message);
        goldAlert({ title: "ERROR", text: "No pudimos procesar tu reporte.", icon: "❌" });
    }
}

// 1. Abre el modal en lugar del prompt feo
function editarBio() {
    if (!currentUser) return;
    const modal = document.getElementById('modal-bio');
    const input = document.getElementById('input-bio-nueva');
    const bioActual = document.getElementById('display-bio').innerText.replace(/"/g, '');
    
    input.value = bioActual === "Toca aquí para añadir tu frase de perfil..." ? "" : bioActual;
    modal.style.display = 'flex';
}

function cerrarModalBio() {
    document.getElementById('modal-bio').style.display = 'none';
}

// 2. Guarda los datos en Supabase
async function guardarNuevaBio() {
    const nuevaBio = document.getElementById('input-bio-nueva').value.trim();
    const textoFinal = nuevaBio || "Toca aquí para añadir tu frase de perfil...";
    
    try {
        const { error } = await _db
            .from('perfiles')
            .update({ bio: textoFinal })
            .ilike('nombre', currentUser);

        if (error) throw error;

        // Actualizamos la UI sin recargar
        document.getElementById('display-bio').innerText = `"${textoFinal}"`;
        cerrarModalBio();
        
    } catch (err) {
        console.error("Error al guardar bio:", err.message);
        
        // Reemplazamos el alert feo del navegador por la Alerta de Oro
        await goldAlert({
            title: "ERROR DE SISTEMA",
            text: "No se pudo actualizar tu biografía debido a un error de conexión con el servidor.",
            icon: "⚡"
        });
    }
}

async function cargarTodosLosAnimes(page) {
    const contenedor = document.getElementById('lista-todos');
    const labelPagina = document.getElementById('page-number-all');
    const paginacion = document.getElementById('paginacion-container');
    
    if (contenedor) {
        contenedor.innerHTML = "<p style='width:100%; text-align:center; color:var(--gold); opacity:0.5;'>Sincronizando biblioteca...</p>";
    }

    try {
        // Intentar Jikan primero, si falla usar Anilist como respaldo automático
        const result = await fetchWithFallback(
            `https://api.jikan.moe/v4/anime?page=${page}&limit=24&order_by=popularity&sort=asc`,
            () => listAnilist(page, 24)
        );

        if (!result.ok) {
            throw new Error(result.error || "No se pudieron cargar los animes.");
        }

        const data = result.data;
        
        if (data && data.length > 0) {
            renderGrid(data, 'lista-todos'); 
            
            paginaActualTodos = page;
            if (labelPagina) {
                if (result.source === 'anilist') {
                    labelPagina.innerHTML = `Página ${page} <span style="font-size:0.6rem; opacity:0.5;"></span>`;
                } else {
                    labelPagina.innerText = `Página ${page}`;
                }
            }
            
            const btnPrev = document.getElementById('btn-prev-all');
            const btnNext = document.getElementById('btn-next-all');

            if (btnPrev) {
                btnPrev.style.opacity = page === 1 ? "0.3" : "1";
                btnPrev.style.pointerEvents = page === 1 ? "none" : "auto";
            }
            if (btnNext) {
                // En Anilist no tenemos paginación exacta, asumimos que siempre hay más si hay datos
                const hasNext = result.source === 'jikan' ? 
                    (result.pagination && result.pagination.has_next_page) : 
                    (data.length >= 24);
                btnNext.style.opacity = hasNext ? "1" : "0.3";
                btnNext.style.pointerEvents = hasNext ? "auto" : "none";
            }

            if (paginacion) {
                paginacion.style.display = data.length >= 24 ? "flex" : "none";
            }
        } else {
            throw new Error("No se encontraron animes.");
        }
    } catch (err) {
        console.error("Error cargando biblioteca:", err);
        
        if (contenedor) {
            const errorMsg = err.name === 'AbortError' 
                ? 'La conexión con la biblioteca tardó demasiado. Verifica tu internet.'
                : err.message || 'Error al conectar con la biblioteca de animes.';
            
            contenedor.innerHTML = `
                <div style="width:100%; text-align:center; padding:40px 20px;">
                    <div style="font-size:2.5rem; margin-bottom:15px;">⚠️</div>
                    <p style="color:#ff6b6b; font-size:0.85rem; margin-bottom:15px;">${errorMsg}</p>
                    <button onclick="cargarTodosLosAnimes(${page})" class="btn-random-gold" style="margin:5px;">🔄 REINTENTAR</button>
                    <button onclick="cargarTodosLosAnimes(1)" class="btn-random-gold" style="margin:5px; border-color:#888; color:#888;">🏠 VOLVER AL INICIO</button>
                </div>`;
        }
    }
}

function cambiarPaginaCompleta(delta) {
    const nuevaPagina = paginaActualTodos + delta;
    if (nuevaPagina >= 1) {
        cargarTodosLosAnimes(nuevaPagina);
    }
}

// ==========================================
// FUNCIÓN PRINCIPAL DE REPRODUCCIÓN
// ==========================================
async function reproducirEpisodio(titulo, num, segundos = 0) {
    ultimoEpisodioCargado = { titulo, num, segundos };
    const container = document.getElementById('video-player-container');
    const infoText = document.getElementById('video-ep-title');
    
    // Registramos esta sesión de reproducción para descartar hilos concurrentes si se cambia de video
    const myPlayId = ++playbackSessionId;
    
    // --- AUTO-VISTO AL REPRODUCIR ---
    // Buscamos el checkbox del episodio actual y lo marcamos si no lo está
    const filaEp = document.querySelector(`.episode-row[data-ep="${num}"]`);
    const cb = filaEp ? filaEp.querySelector('input[type="checkbox"]') : null;
    if (cb && !cb.checked) {
        cb.checked = true;
        toggleEpisodioVisto(currentAnime.mal_id, num, cb);
    }
    
    if (!container || !currentAnime) return;

    // --- 💎 CONTROL DE ACCESO PREMIUM Y ANUNCIOS ---
    const perfil = JSON.parse(localStorage.getItem('aidume_profile'));
    const esPremium = perfil && perfil.premium;

    if (!esPremium) {
        // Lanzamos el anuncio (Pop-under)
        if (typeof lanzarAnuncio === 'function') lanzarAnuncio();

        // Preparamos el contenedor para mostrar la espera Gold
        container.style.display = "block";
        container.innerHTML = `
            <div id="ad-wait-screen" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; min-height:300px; background:#050505; border: 2px solid var(--gold); border-radius:15px; text-align:center; padding:20px; box-sizing: border-box;">
                <div style="font-size:3rem; margin-bottom:15px; animation: pulseGold 2s infinite;">⏳</div>
                <h3 style="color:var(--gold); text-transform:uppercase; margin-bottom:10px; font-size:1.1rem; letter-spacing:1px;">Preparando Acceso Gold</h3>
                <p style="color:#eee; font-size:0.9rem;">El reproductor se activará en <span id="segundos-espera" style="font-weight:bold; font-size:1.8rem; color:var(--gold);">20</span> segundos.</p>
                <div style="margin-top:25px; padding:15px; background:rgba(255,215,0,0.05); border-radius:10px; border:1px solid rgba(255,215,0,0.2);">
                    <p style="font-size:0.8rem; color:#888; margin:0 0 10px 0;">👑 ¿Cansado de los anuncios y la espera?</p>
                    <button onclick="showPage('perfil')" class="btn-random-gold" style="margin:0; width:100%;">OBTENER RANGO PREMIUM</button>
                </div>
            </div>`;
        container.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // Contador de 20 segundos real
        let seg = 20;
        await new Promise(resolve => {
            const timer = setInterval(() => {
                // Si el usuario cambió de video, abortamos este contador y limpiamos
                if (myPlayId !== playbackSessionId) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                seg--;
                const display = document.getElementById('segundos-espera');
                if (display) display.innerText = seg;
                if (seg <= 0) {
                    clearInterval(timer);
                    resolve();
                }
            }, 1000);
        });

        // Verificamos de nuevo tras la espera
        if (myPlayId !== playbackSessionId) return;
    } else {
        // Si es premium, esperamos solo un suspiro para estabilidad
        await new Promise(resolve => setTimeout(resolve, 400));
        if (myPlayId !== playbackSessionId) return;
    }

    // 1. LIMPIEZA
    container.innerHTML = ""; 
    container.style.display = "block";
    
    // Eliminamos cualquier rastro de botones de intentos anteriores
    const botonViejo = document.getElementById('btn-play-extra');
    if (botonViejo) botonViejo.remove();

    try {
        // Consultamos a Supabase
        const { data: enlaceManual } = await _db
            .from('enlaces_episodios')
            .select('url_video')
            .eq('anime_id', currentAnime.mal_id)
            .eq('episodio_num', num)
            .eq('idioma', idiomaActual)
            .maybeSingle();

        if (myPlayId !== playbackSessionId) return;

        // --- LÓGICA DE LIMPIEZA DE IFRAME ---
        let urlSucia = (enlaceManual && enlaceManual.url_video) ? enlaceManual.url_video : "";
        let urlFinal = "";

        if (urlSucia.toLowerCase().includes("<iframe")) {
            // Extraemos solo lo que está dentro de src="..." (insensible a mayúsculas y flexible con comillas)
            const match = urlSucia.match(/src=["']?([^"'\s>]+)["']?/i);
            urlFinal = (match && match[1]) ? match[1] : urlSucia;
        } else {
            urlFinal = urlSucia;
        }
        // ------------------------------------
        
        if (!urlFinal) {
            const sufijo = idiomaActual === 'lat' ? "latino" : "sub español";
            urlFinal = `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titulo + " episodio " + num + " " + sufijo)}`;
        }

        // ⏱️ AGREGAR TIEMPO DE REANUDACIÓN AL URL
        if (segundos > 0) {
            // Los reproductores que usas (nyuu, filemoon, streamhg, vidhide, netu, uqload, streamtape)
            // son embebidos HTML5. La mayoría soporta el fragmento #t=SEGUNDOS (HTML5 video spec)
            // o alternativamente el parámetro ?t=SEGUNDOS
            const separadorHash = urlFinal.includes('#') ? '&' : '#';
            const separadorQuery = urlFinal.includes('?') ? '&' : '?';
            
            // Detectar el dominio para elegir el método correcto
            const dominio = urlFinal.toLowerCase();
            
            if (dominio.includes('youtube.com') || dominio.includes('youtu.be')) {
                // YouTube: parámetro t=SEGUNDOSs
                urlFinal += `${separadorQuery}t=${segundos}s`;
            }
            else if (dominio.includes('uqload') || dominio.includes('filemoon') || dominio.includes('streamtape')) {
                // Uqload, Filemoon, Streamtape: soportan #t=SEGUNDOS (HTML5 fragment)
                urlFinal += `${separadorHash}t=${segundos}`;
            }
            else if (dominio.includes('netu') || dominio.includes('netu.tv') || dominio.includes('waaw') || dominio.includes('kaa')) {
                // Netu/Waaw/Kaa: soportan #t=SEGUNDOS
                urlFinal += `${separadorHash}t=${segundos}`;
            }
            else if (dominio.includes('nyuu') || dominio.includes('streamhg') || dominio.includes('vidhide')) {
                // Nyuu, StreamHG, VidHide: soportan #t=SEGUNDOS
                urlFinal += `${separadorHash}t=${segundos}`;
            }
            else if (dominio.includes('mp4upload') || dominio.includes('yourupload')) {
                // Mp4upload y YourUpload: fragmento HTML5
                urlFinal += `${separadorHash}t=${segundos}`;
            }
            else if (dominio.includes('dailymotion.com')) {
                // Dailymotion: parámetro start=SEGUNDOS
                urlFinal += `${separadorQuery}start=${segundos}`;
            }
            else if (dominio.includes('ok.ru') || dominio.includes('vk.com')) {
                // OK.ru y VK: parámetro t=SEGUNDOS
                urlFinal += `${separadorQuery}t=${segundos}`;
            }
            else {
                // Fallback genérico: #t=SEGUNDOS (HTML5 video spec universal)
                urlFinal += `${separadorHash}t=${segundos}`;
            }
        }

        // 2. CREACIÓN DEL REPRODUCTOR (Esperamos 200ms para asegurar estabilidad en Android)
        setTimeout(() => {
            if (myPlayId !== playbackSessionId) return;

            const nuevoIframe = document.createElement('iframe');
            nuevoIframe.className = "video-iframe-aidume";
            nuevoIframe.style.width = "100%";
            nuevoIframe.style.height = "100%";
            nuevoIframe.setAttribute('allowfullscreen', 'true');
            nuevoIframe.setAttribute('frameborder', '0');
            
            if (urlFinal.includes("mp4upload") || urlFinal.includes("yourupload")) {
                // MODO COMPATIBLE: Activamos popups para que el servidor suelte el video.
                // Tu código Java en Android Studio se encargará de que no se abran realmente.
                nuevoIframe.setAttribute("sandbox", "allow-forms allow-pointer-lock allow-same-origin allow-scripts allow-popups allow-top-navigation-by-user-activation");
                console.log("Modo compatible activado: Esperando video...");
            }

            nuevoIframe.src = urlFinal;
            container.appendChild(nuevoIframe);
            
            // 💡 REGISTRO DE TIEMPO DE INICIO Y LIMPIEZA DE INTERVALOS PREVIOS
            playbackStartTime = Date.now();
            if (progresoIntervalGlobal) clearInterval(progresoIntervalGlobal);

            // Guardar progreso inicial al cargar el episodio (0 segundos)
            guardarProgresoReproduccion(currentAnime.mal_id, num, 0);
            
            // Configurar guardado automático de progreso cada 30 segundos
            progresoIntervalGlobal = setInterval(() => {
                if (container.style.display === 'none' || myPlayId !== playbackSessionId) {
                    clearInterval(progresoIntervalGlobal);
                    return;
                }
                // Estimamos el progreso basado en el tiempo transcurrido
                const tiempoEstimado = Math.floor((Date.now() - playbackStartTime) / 1000);
                guardarProgresoReproduccion(currentAnime.mal_id, num, tiempoEstimado);
            }, 30000);
            
            // Scroll suave al reproductor para centrar la vista
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // 4. ACTUALIZAR TÍTULO E IDIOMA (Solo si este hilo sigue activo)
            if (infoText) {
                urlTransmisionActual = urlFinal;
                const flag = idiomaActual === 'lat' ? "banderas/mx.png" : "banderas/jp.png";
                infoText.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%; text-align:left;">
                        <span>📺 Viendo: ${titulo} - Ep ${num} <img src="${flag}" style="width:16px; vertical-align:middle;"></span>
                        <button onclick="transmitirTV()" class="btn-cast-gold">
                            <i>📡</i> TV
                        </button>
                    </div>`;
            }
        }, 200);

    } catch (err) {
        console.error("Error en el reproductor:", err);
    }
}

// ==========================================
// LISTENER PARA PANTALLA COMPLETA
// ==========================================
document.addEventListener('fullscreenchange', () => {
    const iframe = document.querySelector('.video-iframe-aidume');
    if (!iframe) return;

    // Resetear a 100% exacto para que no sobre espacio abajo ni se corte arriba
    iframe.style.height = "100%"; 
    iframe.style.clipPath = "none"; 

    if (document.fullscreenElement) {
        // En pantalla completa aseguramos que ocupe todo el monitor
        iframe.style.width = "100vw";
        iframe.style.height = "100vh";
    }
});

function maximizarVideoAidume(boton) {
    // Buscamos el contenedor 'video-clipper' más cercano al botón que tocaste
    const videoContainer = boton.closest('.video-clipper');
    
    if (!videoContainer) return;

    if (!document.fullscreenElement) {
        if (videoContainer.requestFullscreen) {
            videoContainer.requestFullscreen();
        } else if (videoContainer.webkitRequestFullscreen) {
            videoContainer.webkitRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}


async function cambiarIdiomaReproductor(nuevoIdioma) {
    idiomaActual = nuevoIdioma;
    
    // Quitamos el estado activo de todos y se lo damos al que clickeamos
    document.querySelectorAll('.btn-idioma').forEach(b => b.classList.remove('active'));
    
    const btnActivo = document.getElementById(`btn-${nuevoIdioma}`);
    if (btnActivo) btnActivo.classList.add('active');

    // Recargamos el episodio actual con el nuevo idioma
    if (ultimoEpisodioCargado) {
        reproducirEpisodio(ultimoEpisodioCargado.titulo, ultimoEpisodioCargado.num);
    }
}

// Función para capturar el ID del anime que estás viendo y ponerlo en el panel
async function capturarIdActual() {
    if (currentAnime && currentAnime.mal_id) {
        const inputId = document.getElementById('adm-anime-id');
        if (inputId) {
            inputId.value = currentAnime.mal_id;
            
            // Efecto visual rápido en el borde del input
            inputId.style.borderColor = "var(--gold)";
            setTimeout(() => inputId.style.borderColor = "rgba(255,215,0,0.3)", 500);
            
            // Opcional: Una alerta de éxito sutil para confirmar la captura
            await goldAlert({
                title: "ID CAPTURADO",
                text: `Se vinculó el ID ${currentAnime.mal_id} (${currentAnime.title}) con éxito.`,
                icon: "📌"
            });
        }
    } else {
        // Reemplazamos el alert feo por tu goldAlert
        await goldAlert({
            title: "ACCESO DENEGADO",
            text: "Primero debes abrir la ficha de un anime (haz clic en uno de la lista) para poder capturar su ID de forma automática.",
            icon: "🔑"
        });
    }
}

/**
 * Copia el contenido del input al portapapeles
 */
async function copiarAlPortapapeles(inputId) {
    const input = document.getElementById(inputId);
    if (!input || !input.value) return;
    
    try {
        await navigator.clipboard.writeText(input.value);
        
        // Feedback visual temporal
        const originalPlaceholder = input.placeholder;
        input.placeholder = "✅ ¡Copiado!";
        input.style.borderColor = "var(--gold)";
        
        setTimeout(() => {
            input.placeholder = originalPlaceholder;
            input.style.borderColor = "";
        }, 1500);
    } catch (err) {
        console.error("Error al copiar:", err);
        goldAlert({
            title: "ERROR",
            text: "No se pudo copiar al portapapeles",
            icon: "❌"
        });
    }
}

async function guardarLinkEpisodio() {
    // 1. Capturamos los valores
    const id = document.getElementById('adm-anime-id').value;
    const num = document.getElementById('adm-ep-num').value;
    const idioma = document.getElementById('adm-idioma').value;
    let url = document.getElementById('adm-url').value.trim();

    // 2. Validación (Reemplazo de alertas de error)
    if (!id) {
        return goldAlert({ title: "FALTA ID", text: "Error: No hay ID de anime. Usa el botón 'Capturar'.", icon: "🆔" });
    }
    if (!num) {
        return goldAlert({ title: "NÚMERO FALTANTE", text: "Error: Indica el número de episodio.", icon: "🔢" });
    }
    if (!url) {
        return goldAlert({ title: "FALTA URL", text: "Error: Pega la URL del video.", icon: "🔗" });
    }

    try {
        // 3. Enviamos los datos a Supabase
        const { error } = await _db
            .from('enlaces_episodios')
            .upsert({ 
                anime_id: parseInt(id), 
                episodio_num: parseInt(num), 
                url_video: url,
                idioma: idioma 
            }, { onConflict: 'anime_id, episodio_num, idioma' });

        if (error) throw error;

        // 4. ÉXITO (Reemplazo de alerta de éxito)
        await goldAlert({
            title: "ENLACE DE ORO",
            text: `¡Episodio ${num} (${idioma}) guardado con éxito!`,
            icon: "🏆",
            confirmText: "SIGUIENTE"
        });

        // Limpieza de campos e incremento automático del episodio
        const epNumInput = document.getElementById('adm-ep-num');
        const currentEp = parseInt(epNumInput.value);
        epNumInput.value = currentEp + 1; // Incrementar al siguiente episodio
        document.getElementById('adm-url').value = ""; // Limpiar solo la URL 
        
    } catch (err) {
        console.error("Error al guardar en Supabase:", err.message);
        goldAlert({
            title: "ERROR DE DB",
            text: "No se pudo guardar: " + err.message,
            icon: "❌"
        });
    }
}

/**
 * Envía una invitación a otro usuario para ver el anime actual
 */
async function abrirPromptInvitacionWP() {
    if (!currentAnime) {
        return goldAlert({ title: "ERROR", text: "No hay un anime cargado.", icon: "❌" });
    }
    
    const invitado = prompt("Ingresa el nombre del usuario al que deseas invitar:");
    if (!invitado) return;

    const epNum = prompt(`¿Para qué episodio quieres invitar a ${invitado}?`, "1") || "1";
    
    const msg = `[WP_INVITE:${currentAnime.mal_id}:${epNum}:${currentUser}]`;
    
    try {
        const { error } = await _db.from('chat_privado').insert([
            { emisor: String(currentUser).trim(), receptor: String(invitado).trim(), mensaje: msg }
        ]);
        if (error) throw error;
        
        goldAlert({ title: "INVITACIÓN ENVIADA", text: "Revisa tu chat privado.", icon: "📩" });
    } catch(e) {
        console.error(e);
        goldAlert({title:"ERROR", text: "No se pudo enviar la invitación."});
    }
}

async function unirseAWatchPartyDesdeChat(animeId, epNum, hostName) {
    if (typeof cerrarChatPrivado === 'function') cerrarChatPrivado();
    
    // Obtenemos los datos del anime si no lo tenemos abierto
    let animeData = null;
    if (currentAnime && currentAnime.mal_id == animeId) {
        animeData = currentAnime;
    } else {
        try {
            const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}`);
            const data = await res.json();
            animeData = data.data;
        } catch(e) {
            console.error(e);
            return goldAlert({title: "Error", text: "No se pudo cargar la información del anime."});
        }
    }
    
    const partyData = {
        host_name: hostName.trim(),
        guest_name: currentUser.trim(),
        anime_id: parseInt(animeId),
        ep_num: parseInt(epNum),
        anime_data: animeData
    };

    unirseAWatchParty(partyData);
}

async function invitarAVer(usuarioInvitado) {
    return goldAlert({ title: "DESACTIVADO", text: "La función Watch Party se encuentra temporalmente inactiva por mantenimiento.", icon: "🚧" });

    /* CÓDIGO ORIGINAL INACTIVO
    if (!currentAnime) {
        return goldAlert({ 
            title: "PASO PREVIO", 
            text: "Primero abre la ficha del anime que quieres ver juntos.", 
            icon: "📺" 
        });
    }

    const epNum = prompt(`¿En qué episodio quieres que se unan?`, "1") || "1";

    const partyData = {
        host_name: currentUser.trim(),
        guest_name: usuarioInvitado.trim(),
        anime_id: currentAnime.mal_id,
        ep_num: parseInt(epNum),
        anime_data: currentAnime
    };
    
    // Mandamos el paquete directo al canal dedicado del invitado
    try {
        const canalInvitado = _db.channel(`usuario-${usuarioInvitado.trim()}`);
        canalInvitado.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                canalInvitado.send({
                    type: 'broadcast',
                    event: 'wp-invite',
                    payload: partyData
                });
                console.log("📨 Invitación P2P enviada a", usuarioInvitado);
            }
        });
    } catch (e) {
        console.error("Error enviando invitación P2P", e);
    }

    await goldAlert({ 
        title: "INVITACIÓN ENVIADA", 
        text: `Esperando a que @${usuarioInvitado} acepte...`, 
        icon: "📩" 
    });

    // Mandamos al Anfitrión a su propia sala
    unirseAWatchParty(partyData);
    */
}

function iniciarCanalDedicadoUsuario() {
    // DESACTIVADO: La función Watch Party P2P no está activa
    return;
    
    /* CÓDIGO ORIGINAL INACTIVO
    if (!currentUser) return;

    console.log("🚀 Iniciando Canal Dedicado para:", currentUser);

    const manejarInvitacion = async (party) => {
        if (window.wpUltimaInvitacion === party.host_name + party.anime_id) return;
        window.wpUltimaInvitacion = party.host_name + party.anime_id;
        setTimeout(() => window.wpUltimaInvitacion = null, 10000);

        console.log("🍿 ¡Invitación P2P recibida!", party);
        reproducirSonidoAnime();

        const aceptar = await goldAlert({
            title: "¡WATCH PARTY!",
            text: `@${party.host_name} quiere ver "${party.anime_data.title}" (Ep. ${party.ep_num}) contigo.`,
            icon: "🍿",
            showCancel: true,
            confirmText: "¡VAMOS!"
        });

        if (aceptar) {
            unirseAWatchParty(party);
        }
    };

    // Canal único por usuario
    window.miCanalDedicado = _db.channel(`usuario-${currentUser.trim()}`)
    .on('broadcast', { event: 'wp-invite' }, (payload) => {
        manejarInvitacion(payload.payload);
    });
    
    window.miCanalDedicado.subscribe((status) => {
        console.log(`📡 Canal Dedicado (${currentUser}):`, status);
    });
    */
}

/**
 * Sincroniza la interfaz para ver el episodio, forzando la salida de perfiles ajenos
 */
async function unirseAWatchParty(party) {
    // 1. Salimos de la vista de perfil para evitar que el overlay de detalles quede bloqueado
    const host = party.host_name;
    const guest = party.guest_name || currentUser;
    const esHost = (host === currentUser);
    const amigo = esHost ? guest : host;

    if (typeof showPage === 'function') showPage('home');

    try {
        // 2. Obtenemos datos frescos del anime por ID para asegurar que la ficha abra correctamente
        const res = await fetch(`https://api.jikan.moe/v4/anime/${party.anime_id}`);
        const json = await res.json();
        const animeCompleto = json.data; 
        if (!animeCompleto) throw new Error("Anime no encontrado");

        // 3. Abrimos la ficha (overlay)
        await showDetails(animeCompleto);
        
        // 4. Cargamos el reproductor con un ligero margen de tiempo para estabilidad
        setTimeout(() => {
            reproducirEpisodio(animeCompleto.title, party.ep_num);

            // --- ACTIVAR WATCH PARTY MEJORADO ---
            wpAbrirModal(esHost, animeCompleto, party.ep_num, amigo);
            
            goldAlert({ 
                title: esHost ? "SALA CREADA" : "SALA VINCULADA", 
                text: esHost ? "Tu invitación ha sido procesada." : `Viendo anime junto a @${host}`, 
                icon: "✨" 
            });
        }, 1200);
    } catch (e) {
        console.error("Error al unirse a Watch Party:", e);
        goldAlert({ title: "ERROR", text: "No pudimos cargar el anime de la invitación.", icon: "❌" });
    }
}

// ===== WATCH PARTY MEJORADO CON SINCRONIZACIÓN Y VOZ =====
let wpRoomId = null;
let wpEsHost = false;
let wpAnimeActual = null;
let wpEpActual = 1;
let wpYouTubePlayer = null;
let wpYouTubeReady = false;
let wpSyncInterval = null;
let wpUltimoSync = { playing: false, time: 0 };
let wpIgnorarSync = false; // Evita loops de sincronización

// Variables WebRTC (Voz)
let wpPeerConnection = null;
let wpLocalStream = null;
let wpRemoteAudio = null;
let wpVoiceActive = false;

const webrtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

/**
 * Abre el modal de Watch Party y configura el canal de sincronización
 */
function wpAbrirModal(esHost, anime, ep, amigo) {
    wpEsHost = esHost;
    wpAnimeActual = anime;
    wpEpActual = ep || 1;
    
    // Entrar en pantalla completa automáticamente si no lo estamos
    const videoContainer = document.querySelector('.video-clipper');
    if (videoContainer && !document.fullscreenElement) {
        try {
            if (videoContainer.requestFullscreen) videoContainer.requestFullscreen();
            else if (videoContainer.webkitRequestFullscreen) videoContainer.webkitRequestFullscreen();
        } catch(e) { console.log("Fullscreen auto bloqueado", e); }
    }

    const modal = document.getElementById('wp-floating-container');
    const titleEl = document.getElementById('wp-anime-title');
    const roleEl = document.getElementById('wp-role-label');
    const epEl = document.getElementById('wp-ep-label');
    const statusEl = document.getElementById('wp-status-indicator');
    const syncStatusEl = document.getElementById('wp-sync-status');
    
    if (titleEl) titleEl.innerText = anime?.title || "Anime";
    if (roleEl) roleEl.innerText = esHost ? '👑 Host' : '🎮 Invitado';
    if (epEl) epEl.innerText = `Episodio ${wpEpActual}`;
    if (statusEl) {
        statusEl.className = 'wp-status-live';
        statusEl.innerText = '📡 EN VIVO';
    }
    if (syncStatusEl) syncStatusEl.innerText = '🔗 Sincronizado';
    
    // Limpiar chat
    const chatArea = document.getElementById('wp-msg-list');
    if (chatArea) chatArea.innerHTML = `<div class="wp-msg-item" style="opacity:0.6; text-align:center; margin-top:5px; font-size:0.8rem;">--- Watch Party Iniciada ---</div>`;
    
    // Generar room ID
    const miUser = currentUser.trim();
    const otroUser = amigo.trim();
    wpRoomId = [miUser, otroUser].sort().join('-').replace(/\s/g, '_');
    
    // Crear/obtener canal Broadcast
    if (wpChatChannel) {
        _db.removeChannel(wpChatChannel);
    }
    
    wpChatChannel = _db.channel(`wp-room-${wpRoomId}`)
    .on('broadcast', { event: 'shout' }, (payload) => {
        recibirMsgWatchParty(payload.payload);
    })
    .on('broadcast', { event: 'sync' }, (payload) => {
        wpRecibirSync(payload.payload);
    })
    .on('broadcast', { event: 'webrtc' }, async (payload) => {
        await wpManejarSenalWebRTC(payload.payload);
    })
    .subscribe((status) => {
        console.log(`📡 WP Canal (${wpRoomId}):`, status);
    });
    
    if (modal) modal.style.display = 'flex';
    
    // Si es host, iniciar envío periódico de sync
    if (esHost) {
        wpIniciarSyncHost();
    }
    
    // Preparar el elemento de audio remoto si no existe
    if (!wpRemoteAudio) {
        wpRemoteAudio = document.createElement('audio');
        wpRemoteAudio.autoplay = true;
        document.body.appendChild(wpRemoteAudio);
    }
    
    // Configurar arrastrar (drag) para el modal
    wpConfigurarDrag();
}

/**
 * Permite arrastrar el chat flotante
 */
function wpConfigurarDrag() {
    const card = document.getElementById('wp-modal');
    const header = document.getElementById('wp-drag-handle');
    if (!card || !header) return;

    let isDragging = false, currentX, currentY, initialX, initialY, xOffset = 0, yOffset = 0;

    header.onmousedown = dragStart;
    document.onmouseup = dragEnd;
    document.onmousemove = drag;

    function dragStart(e) {
        initialX = e.clientX - xOffset;
        initialY = e.clientY - yOffset;
        if (e.target === header || header.contains(e.target)) {
            isDragging = true;
        }
    }
    function dragEnd(e) {
        initialX = currentX;
        initialY = currentY;
        isDragging = false;
    }
    function drag(e) {
        if (isDragging) {
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            xOffset = currentX;
            yOffset = currentY;
            card.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        }
    }
}

/**
 * Ocultar/Mostrar el chat flotante
 */
function wpToggleChat() {
    const card = document.getElementById('wp-modal');
    const btn = document.getElementById('wp-toggle-btn');
    if (!card) return;
    
    if (card.style.display === 'none') {
        card.style.display = 'flex';
        btn.innerText = '💬 Ocultar Chat';
    } else {
        card.style.display = 'none';
        btn.innerText = '💬 Mostrar Chat';
    }
}

// ==== WEBRTC VOZ LOGICA ====

async function toggleWpVoice() {
    const btn = document.getElementById('wp-voice-btn');
    if (wpVoiceActive) {
        // Desconectar
        wpVoiceActive = false;
        if (wpLocalStream) {
            wpLocalStream.getTracks().forEach(track => track.stop());
            wpLocalStream = null;
        }
        if (wpPeerConnection) {
            wpPeerConnection.close();
            wpPeerConnection = null;
        }
        btn.innerText = '🎤 Unirse a Voz';
        btn.style.background = 'var(--gold)';
    } else {
        // Conectar
        try {
            wpLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            wpVoiceActive = true;
            btn.innerText = '🔇 Salir de Voz';
            btn.style.background = '#ff4444';
            
            // Iniciar llamada (el Host generalmente inicia, pero cualquiera puede)
            wpIniciarWebRTC();
        } catch (e) {
            console.error('Error accediendo al micrófono:', e);
            alert('No se pudo acceder al micrófono. Asegúrate de dar los permisos.');
        }
    }
}

function wpCrearPeerConnection() {
    wpPeerConnection = new RTCPeerConnection(webrtcConfig);
    
    // Agregar tracks locales
    if (wpLocalStream) {
        wpLocalStream.getTracks().forEach(track => {
            wpPeerConnection.addTrack(track, wpLocalStream);
        });
    }

    // Escuchar tracks remotos
    wpPeerConnection.ontrack = (event) => {
        if (wpRemoteAudio) {
            wpRemoteAudio.srcObject = event.streams[0];
        }
    };

    // ICE Candidates
    wpPeerConnection.onicecandidate = (event) => {
        if (event.candidate && wpChatChannel) {
            wpChatChannel.send({
                type: 'broadcast',
                event: 'webrtc',
                payload: { type: 'ice', candidate: event.candidate, sender: currentUser }
            });
        }
    };
    
    return wpPeerConnection;
}

async function wpIniciarWebRTC() {
    const pc = wpCrearPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    wpChatChannel.send({
        type: 'broadcast',
        event: 'webrtc',
        payload: { type: 'offer', offer: offer, sender: currentUser }
    });
}

async function wpManejarSenalWebRTC(payload) {
    if (payload.sender === currentUser) return; // Ignorar nuestros propios mensajes
    if (!wpVoiceActive) return; // Si no estamos en voz, ignorar
    
    try {
        if (payload.type === 'offer') {
            const pc = wpPeerConnection || wpCrearPeerConnection();
            await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            wpChatChannel.send({
                type: 'broadcast',
                event: 'webrtc',
                payload: { type: 'answer', answer: answer, sender: currentUser }
            });
        } else if (payload.type === 'answer') {
            if (wpPeerConnection) {
                await wpPeerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
            }
        } else if (payload.type === 'ice') {
            if (wpPeerConnection) {
                await wpPeerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
            }
        }
    } catch (e) {
        console.error("Error WebRTC signaling:", e);
    }
}


/**
 * Inicia el envío periódico de estado de reproducción (solo Host)
 */
function wpIniciarSyncHost() {
    if (wpSyncInterval) clearInterval(wpSyncInterval);
    
    wpSyncInterval = setInterval(() => {
        if (!wpChatChannel || !wpEsHost) return;
        
        const iframe = document.querySelector('.video-iframe-aidume');
        if (!iframe) return;
        
        // Intentar detectar estado del reproductor
        // Para YouTube, intentamos comunicación vía postMessage
        let playing = false;
        let currentTime = 0;
        
        // Verificamos si el iframe está visible y tiene src
        const container = document.getElementById('video-player-container');
        if (container && container.style.display !== 'none' && iframe.src && !iframe.src.includes('about:blank')) {
            playing = true;
            // Estimamos tiempo basado en elapsed desde que empezó
            if (wpUltimoSync.playing) {
                currentTime = wpUltimoSync.time + 1; // +1 segundo cada tick
            }
        }
        
        const syncData = {
            playing: playing,
            time: currentTime,
            episode: wpEpActual,
            animeId: wpAnimeActual?.mal_id,
            timestamp: Date.now()
        };
        
        wpChatChannel.send({
            type: 'broadcast',
            event: 'sync',
            payload: syncData
        });
        
        wpUltimoSync = syncData;
    }, 3000); // Cada 3 segundos
}

/**
 * Recibe un evento de sincronización del Host
 */
function wpRecibirSync(data) {
    if (wpEsHost) return; // El host no se sincroniza consigo mismo
    if (wpIgnorarSync) return;
    
    const statusEl = document.getElementById('wp-status-indicator');
    const syncStatusEl = document.getElementById('wp-sync-status');
    const epLabel = document.getElementById('wp-ep-label');
    
    // Actualizar episodio si cambió
    if (data.episode && data.episode !== wpEpActual) {
        wpEpActual = data.episode;
        epLabel.innerText = `Episodio ${wpEpActual}`;
        
        // Si el invitado tiene el anime abierto, cambiar de episodio
        if (currentAnime && currentAnime.mal_id === data.animeId) {
            reproducirEpisodio(currentAnime.title, wpEpActual);
        }
    }
    
    // Actualizar estado visual
    if (data.playing) {
        statusEl.className = 'wp-status-live';
        statusEl.innerText = '📡 EN VIVO';
        syncStatusEl.innerText = '🔗 Sincronizado';
    } else {
        statusEl.className = 'wp-status-paused';
        statusEl.innerText = '⏸️ PAUSADO';
        syncStatusEl.innerText = '⏸️ Pausado por el Host';
    }
    
    // Intentar sincronizar el iframe del invitado
    wpIntentarSyncIframe(data);
}

/**
 * Intenta sincronizar el iframe del invitado (YouTube API)
 */
function wpIntentarSyncIframe(data) {
    const iframe = document.querySelector('.video-iframe-aidume');
    if (!iframe) return;
    
    // Para YouTube, usamos la API de postMessage
    if (iframe.src && iframe.src.includes('youtube.com')) {
        try {
            if (data.playing) {
                iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
            } else {
                iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
            }
            if (data.time > 0) {
                iframe.contentWindow.postMessage(`{"event":"command","func":"seekTo","args":[${data.time},true]}`, '*');
            }
        } catch(e) {
            console.warn("WP: No se pudo controlar el iframe de YouTube", e);
        }
    }
}

/**
 * El invitado solicita sincronización forzada al Host
 */
function wpSolicitarSync() {
    if (!wpChatChannel || wpEsHost) return;
    
    const btn = document.getElementById('wp-btn-sync');
    btn.innerText = '⏳ Solicitando...';
    btn.disabled = true;
    
    // Enviamos petición de sync al host
    wpChatChannel.send({
        type: 'broadcast',
        event: 'shout',
        payload: { user: '🎬 Sistema', text: `@${currentUser} solicita sincronización...` }
    });
    
    // Re-enviamos el último sync conocido para forzar actualización
    if (wpUltimoSync) {
        wpIntentarSyncIframe(wpUltimoSync);
    }
    
    setTimeout(() => {
        btn.innerText = '🔄 Sincronizar';
        btn.disabled = false;
    }, 2000);
}

/**
 * Envía un comando de sincronización manual (Host controla)
 */
function wpEnviarComando(comando, valor) {
    if (!wpChatChannel || !wpEsHost) return;
    
    const syncData = {
        playing: comando === 'play',
        time: comando === 'seek' ? valor : wpUltimoSync.time,
        episode: wpEpActual,
        animeId: wpAnimeActual?.mal_id,
        timestamp: Date.now(),
        comando: comando,
        valor: valor
    };
    
    wpChatChannel.send({
        type: 'broadcast',
        event: 'sync',
        payload: syncData
    });
    
    wpUltimoSync = syncData;
}

/**
 * Envía mensaje de chat en el Watch Party
 */
function enviarMsgWatchParty() {
    const input = document.getElementById('wp-input-msg');
    const text = input.value.trim();
    if (!text || !wpChatChannel) return;

    const msgData = { user: currentUser, text: text };
    
    wpChatChannel.send({
        type: 'broadcast',
        event: 'shout',
        payload: msgData,
    });

    recibirMsgWatchParty(msgData);
    input.value = "";
}

/**
 * Recibe y muestra un mensaje del chat Watch Party
 */
function recibirMsgWatchParty(data) {
    const list = document.getElementById('wp-msg-list');
    const item = document.createElement('div');
    item.className = "wp-msg-item";
    
    if (data.user === '🎬 Sistema') {
        item.style.color = '#ff8c00';
        item.style.fontStyle = 'italic';
        item.style.fontSize = '0.75rem';
        item.innerHTML = data.text;
    } else {
        item.innerHTML = `<b>${data.user}:</b> ${data.text}`;
    }
    
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
}

/**
 * Cierra y limpia el Watch Party
 */
function salirWatchParty() {
    const modal = document.getElementById('wp-floating-container');
    if (modal) modal.style.display = 'none';
    
    // Limpiar canal
    if (wpChatChannel) {
        _db.removeChannel(wpChatChannel);
        wpChatChannel = null;
    }
    
    // Limpiar intervalos
    if (wpSyncInterval) {
        clearInterval(wpSyncInterval);
        wpSyncInterval = null;
    }
    
    // Limpiar WebRTC
    if (wpVoiceActive) {
        toggleWpVoice(); // Esto limpiará los streams y la conexión
    }
    if (wpRemoteAudio) {
        wpRemoteAudio.remove();
        wpRemoteAudio = null;
    }
    
    wpRoomId = null;
    wpEsHost = false;
    wpAnimeActual = null;
    wpYouTubePlayer = null;
    wpYouTubeReady = false;
    wpUltimoSync = { playing: false, time: 0 };
    
    console.log("🚪 Watch Party finalizada.");
}


// Abrir y cerrar el chat
async function toggleChat() {
    const win = document.getElementById('chat-window');
    const isOpen = win.style.display === 'flex';
    
    win.style.display = isOpen ? 'none' : 'flex';

    if (isOpen) {
        const pkStk = document.getElementById('global-sticker-picker');
        const pkEmo = document.getElementById('global-emoji-picker');
        if (pkStk) pkStk.style.display = 'none';
        if (pkEmo) pkEmo.style.display = 'none';
    }
    
    if(!isOpen) {
        const ahora = new Date().toISOString();
        
        // --- PERSISTENCIA GOLD: Guardamos lectura en DB y local ---
        localStorage.setItem('last_chat_read', ahora);

        if (currentUser) {
            // Guardamos en la base de datos para que persista tras cerrar sesión
            await _db.from('perfiles').update({ ultimo_visto_chat: ahora }).ilike('nombre', currentUser);
            
            // Sincronizamos el perfil local
            const p = JSON.parse(localStorage.getItem('aidume_profile'));
            if(p) {
                p.ultimo_visto_chat = ahora;
                localStorage.setItem('aidume_profile', JSON.stringify(p));
            }
        }

        const badge = document.getElementById('chat-badge');
        if(badge) { badge.innerText = "0"; badge.style.display = "none"; }
        
        aplicarTemaChatLocal();
        cargarMensajesChat();
    }
}

// Cerrar chat al hacer clic fuera
window.addEventListener('click', (e) => {
    const win = document.getElementById('chat-window');
    const bubble = document.getElementById('chat-bubble');
    const picker = document.getElementById('global-emoji-picker');
    const stickerPicker = document.getElementById('global-sticker-picker');

    // Si el chat está abierto, cerramos solo si el clic NO es en la ventana, ni en la burbuja, ni en los selectores
    if (win?.style.display === 'flex' && !win.contains(e.target) && !bubble.contains(e.target) && (!picker || !picker.contains(e.target)) && (!stickerPicker || !stickerPicker.contains(e.target))) {
        toggleChat();
    }
});

/**
 * Aplica el tema (contorno y fondo) a la ventana de chat del usuario actual
 */
async function aplicarTemaChatLocal() {
    if (!currentUser) return;
    const { data } = await _db.from('perfiles').select('tema_chat').eq('nombre', currentUser).single();
    const win = document.getElementById('chat-window');
    if (!win) return;

    // Limpiamos clases de temas anteriores
    win.className = win.className.replace(/\bchat-theme-\S+/g, '');
    
    if (data?.tema_chat) {
        win.classList.add(`chat-theme-${data.tema_chat}`);
    }
}

async function enviarMensajeChat() {
    const input = document.getElementById('chat-input');
    const texto = input.value.trim();
    
    // Si no hay texto o no hay usuario logueado, no hace nada
    if(!texto || !currentUser) return; 

    // Verificar si hay una respuesta pendiente
    let replyToJson = null;
    if (input.dataset.replyTo) {
        try {
            replyToJson = JSON.parse(input.dataset.replyTo);
        } catch(e) {}
        // Limpiar la respuesta
        delete input.dataset.replyTo;
        const barra = document.getElementById('reply-bar-chat-input');
        if (barra) barra.style.display = 'none';
    }

    const mensajeData = { 
        usuario: currentUser,
        mensaje: texto 
    };
    if (replyToJson) {
        mensajeData.reply_to_json = replyToJson;
    }

    const { error } = await _db.from('chat_global').insert([mensajeData]);

    if (error) {
        console.error("Error al enviar:", error.message);
    } else {
        input.value = "";
        reproducirSonidoChat();
        cargarMensajesChat();
    }
}

// Variable para controlar el último ID de mensaje cargado
let ultimoIdMensajeChat = 0;

async function cargarMensajesChat() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const tiempoLimite = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const perfilLocal = JSON.parse(localStorage.getItem('aidume_profile'));
    const ultimaVezLeido = perfilLocal?.ultimo_visto_chat || localStorage.getItem('last_chat_read') || tiempoLimite;
    const chatAbierto = document.getElementById('chat-window').style.display === 'flex';

    // Traer mensajes NUEVOS
    let query = _db
        .from('chat_global')
        .select(`
            id, usuario, mensaje, fecha, reply_to_json,
            perfiles (avatar_id, es_premium, tema_chat, racha_dias, online, ultima_conexion)
        `)
        .gt('fecha', tiempoLimite)
        .order('fecha', { ascending: true });

    if (ultimoIdMensajeChat > 0) {
        query = query.gt('id', ultimoIdMensajeChat);
    }

    const { data: mensajes, error } = await query;

    if (error) {
        console.error("Error Chat:", error.message);
        return;
    }

    if (!mensajes || mensajes.length === 0) return;

    const esCargaInicial = (ultimoIdMensajeChat === 0);
    
    if (esCargaInicial) {
        container.innerHTML = "";
    }

    let nuevosCount = 0;
    let mencionDetectada = false;
    let htmlNuevos = "";

    // Recuperamos la lista de reportes automáticos ya enviados en esta sesión/dispositivo
    let reportesEnviados = JSON.parse(localStorage.getItem('reportes_automaticos_enviados')) || [];

    mensajes.forEach(async (m) => {
        // Actualizar el último ID
        if (m.id > ultimoIdMensajeChat) ultimoIdMensajeChat = m.id;

        // Si el mensaje ya existe en el DOM, lo saltamos
        if (!esCargaInicial && document.querySelector(`[data-msg-id="${m.id}"]`)) return;

        // 🚨 AUTOMODERACIÓN: DETECCIÓN DE OFENSAS O LINKS
        let mensajeProcesado = m.mensaje;
        let esOfensivo = contieneOfensa(m.mensaje);

        if (esOfensivo) {
            // 1. Censura visual inmediata en el chat
            mensajeProcesado = `🚫 [Mensaje ocultado por el sistema de moderación]`;

            // 2. Reporte automático a la base de datos (si no se envió antes)
            if (!reportesEnviados.includes(m.id)) {
                reportesEnviados.push(m.id);
                localStorage.setItem('reportes_automaticos_enviados', JSON.stringify(reportesEnviados));

                // Insertamos directo en tu tabla de reportes
                const motivoAuto = `[AUTOMOD_CHAT] Mensaje ofensivo o link detectado automáticamente | Mensaje original: "${m.mensaje}" (Usuario: ${m.usuario})`;
                
                await _db.from('reportes').insert([{
                    comentario_id: null, // O usar una columna específica si agregás chat_id en un futuro
                    usuario_reporta: "SISTEMA_AUTO_MOD",
                    motivo: motivoAuto
                }]);
            }
        }

        const todosLosAvatares = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
        const perfilData = Array.isArray(m.perfiles) ? m.perfiles[0] : m.perfiles;
        const esPremium = perfilData?.es_premium;
        const avId = perfilData?.avatar_id || '1';
        const avData = todosLosAvatares.find(a => a.id === String(avId)) || AVATARES_RANGOS[0];

        let esOnlineDoble = false;
        if (perfilData?.ultima_conexion) {
            let isoStringChat = perfilData.ultima_conexion.trim().replace(" ", "T");
            if (!isoStringChat.endsWith('Z') && !isoStringChat.includes('+') && !isoStringChat.includes('-')) {
                isoStringChat += 'Z';
            }
            const fechaObjChat = new Date(isoStringChat);
            const latidoMs = Math.abs(Date.now() - fechaObjChat.getTime());
            esOnlineDoble = (perfilData?.online === true && latidoMs < 300000);
        }
        const esOnline = esOnlineDoble;

        if (m.fecha > ultimaVezLeido) nuevosCount++;

        // Usamos la variable 'mensajeProcesado' (que puede estar censurada o limpia)
        let textoMsj = parsearMensajeParaStickers(mensajeProcesado);
        
        // Si el mensaje es ofensivo, anulamos las menciones para no molestar al usuario arrobado
        const regexMencion = new RegExp(`@${currentUser}`, 'i');
        const soyYoArrobado = currentUser && regexMencion.test(mensajeProcesado) && !esOfensivo;

        if (soyYoArrobado) {
            textoMsj = mensajeProcesado.replace(regexMencion, `<span class="chat-mention-me">$&</span>`);
            if (m.fecha > ultimaVezLeido) mencionDetectada = true;
        }

        const temaClase = perfilData?.tema_chat ? `msg-skin-${perfilData.tema_chat}` : '';
        const estiloPremium = esPremium 
            ? 'border: 1.5px solid var(--gold); background: rgba(255, 215, 0, 0.12); position: relative; box-shadow: inset 0 0 10px rgba(255,215,0,0.1);' 
            : '';
        const coronaPremium = esPremium 
            ? '<span style="position:absolute; bottom:4px; right:8px; font-size:0.7rem; filter:drop-shadow(0 0 3px gold);">👑</span>' 
            : '';

        // Si es ofensivo, desactivamos la opción de citar/responder para no propagar el spam
        const replyHtml = esOfensivo ? "" : renderizarRespuestaCitada(m.reply_to_json);
        const accionesHtml = esOfensivo ? "" : `
            <div class="chat-msg-actions">
                <button class="chat-action-btn" onclick="mostrarSelectorReacciones(${m.id}, 'chat_global', this)" title="Reaccionar">😊</button>
                <button class="chat-action-btn" onclick="responderAMensaje(${m.id}, '${m.usuario}', '${m.mensaje.replace(/'/g, "\\'").replace(/"/g, '"')}', 'chat-input')" title="Responder">↩️</button>
            </div>`;

        const msgHtml = `
            <div class="chat-msg-row" data-msg-id="${m.id}" data-msg-table="chat_global">
                <div style="position: relative; flex-shrink: 0;">
                    <img src="${avData.img}" class="chat-avatar-mini" 
                         onclick="verPerfilAjeno('${m.usuario}')" 
                         style="cursor:pointer;">
                    <span class="${esOnline ? 'online-dot' : 'offline-dot'}" style="position: absolute; top: -2px; right: -2px; border: 2px solid #111; margin: 0; box-sizing: content-box;"></span>
                </div>
                <div class="chat-msg-body ${temaClase}" style="${estiloPremium}">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong class="chat-user-name" onclick="verPerfilAjeno('${m.usuario}')" style="cursor:pointer; text-decoration:underline;">@${m.usuario}</strong>
                        ${obtenerHtmlRacha(perfilData?.racha_dias)}
                        <button onclick="reportarMensajeChat(${m.id}, '${m.usuario}')" class="btn-report-chat" ${esOfensivo ? 'disabled style="opacity:0.2;"' : ''}>🚩</button>
                    </div>
                    ${replyHtml}
                    <div class="chat-text" style="color:${esOfensivo ? '#ff4757' : (esPremium ? 'var(--gold)' : 'white')}; font-size:0.9rem; font-style:${esOfensivo ? 'italic' : 'normal'}; font-weight:${esPremium ? 'bold' : 'normal'};">${textoMsj}</div>
                    ${coronaPremium}
                    <div class="chat-reactions-container" id="reacciones-${m.id}-chat_global"></div>
                    ${accionesHtml}
                </div>
            </div>`;

        if (esCargaInicial) {
            htmlNuevos += msgHtml;
        } else {
            container.insertAdjacentHTML('beforeend', msgHtml);
            cargarReaccionesEnMensaje(m.id, 'chat_global');
        }
    });

    if (esCargaInicial && htmlNuevos) {
        container.innerHTML = htmlNuevos;
        mensajes.forEach(m => cargarReaccionesEnMensaje(m.id, 'chat_global'));
    }

    if (chatAbierto) {
        container.scrollTop = container.scrollHeight;
        const ahora = new Date().toISOString();
        localStorage.setItem('last_chat_read', ahora);
        const p = JSON.parse(localStorage.getItem('aidume_profile'));
        if (p && p.ultimo_visto_chat !== ahora) {
            p.ultimo_visto_chat = ahora;
            localStorage.setItem('aidume_profile', JSON.stringify(p));
        }
    } else if (nuevosCount > 0) {
        const badge = document.getElementById('chat-badge');
        if (badge) {
            badge.innerText = nuevosCount > 99 ? "+99" : nuevosCount;
            badge.style.display = "block";
        }
        if (mencionDetectada) {
            reproducirSonidoChat();
            lanzarNotificacionSistema("💎 AIDUME: ¡TE MENCIONARON!", `Alguien te ha etiquetado en el chat global.`);
        }
    }
}

// Auto-actualizar el chat cada 10 segundos (siempre corre para ver notificaciones)
setInterval(() => {
    cargarMensajesChat();
}, 10000);

async function reportarMensajeChat(msjId, usuarioReportado) {
    if (!currentUser) {
        return goldAlert({ title: "INICIA SESIÓN", text: "Necesitas una cuenta para reportar mensajes.", icon: "👤" });
    }
    
    // --- PASO CLAVE: CAPTURAR EL TEXTO ANTES DE MOSTRAR EL MODAL ---
    // Usamos el ID del mensaje para buscarlo en el DOM inmediatamente
    const msjRow = document.querySelector(`button[onclick*="${msjId}"]`)?.closest('.chat-msg-row');
    const textoMensaje = msjRow ? msjRow.querySelector('.chat-text').innerText : "Mensaje no encontrado";

    // Ahora que ya tenemos el texto guardado en la variable 'textoMensaje', 
    // no importa si el mensaje se borra o se mueve en el chat.
    
    const motivoUser = await goldAlert({
        title: "🛡️ MODERACIÓN AIDUME",
        text: `Reportando a @${usuarioReportado}. ¿Cuál es el motivo del reporte?`,
        icon: "💜",
        showInput: true,
        showCancel: true,
        confirmText: "ENVIAR REPORTE"
    });
    
    if (motivoUser && motivoUser.trim().length > 3) {
        const motivoFinal = `[CHAT_PURPLE] Motivo: ${motivoUser.trim()} | Mensaje: "${textoMensaje}" (Usuario: ${usuarioReportado})`;

        const { error } = await _db.from('reportes').insert([{
            comentario_id: null, 
            usuario_reporta: currentUser,
            motivo: motivoFinal 
        }]);
        
        if (!error) {
            goldAlert({
                title: "ENVIADO",
                text: "Reporte de chat enviado con éxito.",
                icon: "✔️"
            });
        }
    } else if (motivoUser !== null) {
        goldAlert({ text: "El motivo es muy corto.", icon: "✍️" });
    }
}

/**
 * Reproduce un sonido de notificación estilo anime
 */
function reproducirSonidoAnime() {
    // Solo suena si NO está el reproductor activo en pantalla
    if (document.getElementById('video-player-container')?.style.display !== 'none') return;

    const audio = new Audio('sonidos/notif.mp3');
    audio.volume = 0.5;
    audio.play().catch(e => console.warn("El audio requiere una interacción previa con la página para sonar.", e));
}

/**
 * Reproduce un sonido para mensajes de chat y menciones
 */
function reproducirSonidoChat() {
    // Solo suena si NO está el reproductor activo en pantalla
    if (document.getElementById('video-player-container')?.style.display !== 'none') return;

    const audio = new Audio('sonidos/chat.mp3');
    audio.volume = 0.4;
    audio.play().catch(e => {});
}

// Funciones para manejar los nuevos modales
function mostrarAlerta(mensaje, titulo = "🛡️ AVISO AIDUME") {
    document.getElementById('alerta-titulo').innerText = titulo;
    document.getElementById('alerta-mensaje').innerText = mensaje;
    document.getElementById('modal-alerta').style.display = 'flex';
}

function cerrarAlerta() {
    document.getElementById('modal-alerta').style.display = 'none';
}

function abrirNormasRegistro() {
    document.getElementById('modal-confirmar-normas').style.display = 'flex';
}

function cerrarConfirmarNormas() {
    document.getElementById('modal-confirmar-normas').style.display = 'none';
}

// Esta función se activará al dar clic en "ACEPTO"
async function aceptarNormasRegistro() {
    cerrarConfirmarNormas();
    await procederConRegistro(); // Llamamos a la lógica final
}


// Carga los últimos episodios subidos por nosotros (desde Supabase + Anilist para imágenes/nombres)
async function cargarUltimosEpisodios() {
    const listaRecientes = document.getElementById('lista-recientes');
    if (!listaRecientes) return;

    try {
        // 1. Traer los últimos 20 episodios subidos a nuestra DB
        const { data: enlaces, error } = await _db
            .from('enlaces_episodios')
            .select('*')
            .order('id', { ascending: false })
            .limit(20);

        if (error) throw error;

        if (!enlaces || enlaces.length === 0) {
            listaRecientes.innerHTML = '<p style="text-align:center; opacity:0.5; padding:20px;">Aún no se han subido episodios.</p>';
            return;
        }

        // 2. Obtener IDs únicos de animes
        const idsUnicos = [...new Set(enlaces.map(ep => ep.anime_id))];
        
        // 3. Obtener metadatos desde Anilist (imágenes, nombres reales, etc.)
        const metadataMap = await fetchAnilistBatch(idsUnicos);

        // 4. Armar la lista usando datos de Anilist para imágenes/nombres
        const animes = [];
        const vistosIds = new Set();
        
        for (const ep of enlaces) {
            const id = ep.anime_id;
            const key = `${id}`;
            if (vistosIds.has(key)) continue;
            vistosIds.add(key);
            
            // Si tenemos datos de Anilist, los usamos
            const meta = metadataMap[id];
            if (meta) {
                animes.push({
                    ...meta,
                    episode_number: ep.episodio_num,
                    _source: 'anilist',
                    _idioma: ep.idioma || 'sub'
                });
            } else {
                // Fallback a datos básicos si Anilist no respondió
                animes.push({
                    mal_id: id,
                    title: ep.anime_nombre || `Anime #${id}`,
                    titles: [{ type: 'Default', title: ep.anime_nombre || `Anime #${id}` }],
                    images: {
                        jpg: {
                            image_url: 'logo-aidume.png',
                            large_image_url: 'logo-grande.png',
                            small_image_url: 'logo-aidume.png'
                        }
                    },
                    synopsis: "Episodio subido por la comunidad de AiduMe.",
                    episodes: ep.episodio_num || 1,
                    status: 'Currently Airing',
                    episode_number: ep.episodio_num,
                    _source: 'db',
                    _idioma: ep.idioma || 'sub'
                });
            }
        }

        if (animes.length > 0) {
            renderGrid(animes, 'lista-recientes');
        } else {
            listaRecientes.innerHTML = '<p style="text-align:center; opacity:0.5; padding:20px;">No se pudieron cargar los episodios recientes.</p>';
        }

    } catch (e) {
        console.error("Error cargando episodios recientes:", e);
        const listaRecientes = document.getElementById('lista-recientes');
        if (listaRecientes) {
            listaRecientes.innerHTML = '<p style="text-align:center; opacity:0.5; padding:20px;">Conectando con la base de datos...</p>';
        }
    }
}

async function buscarAnimeFusion(pagina = 1) {
    paginaBusqueda = pagina;
    const q = document.getElementById('busqueda').value.trim();
    
    // 1. Referencias a los contenedores principales
    const seccionTop10 = document.getElementById('seccion-top-10');
    const seccionRecientes = document.getElementById('seccion-ultimos-episodios');
    const paginacionNormal = document.getElementById('paginacion-container');
    const listaTodos = document.getElementById('lista-todos');

    // 2. Referencias precisas a los títulos dentro de sus padres
    const tituloTop10 = seccionTop10 ? seccionTop10.querySelector('.section-h') : null;
    const tituloRecientes = seccionRecientes ? seccionRecientes.querySelector('.section-h') : null;
    
    // Para el título de "Todos los Animes", buscamos el que está justo antes de 'lista-todos'
    const tituloTodos = listaTodos ? listaTodos.previousElementSibling.querySelector('.section-h') : null;

    // --- ESTADO: BUSCADOR VACÍO (RESTAURAR TODO) ---
    if (q.length === 0) {
        // Mostramos las secciones ocultas
        if (seccionTop10) seccionTop10.style.display = 'block';
        if (seccionRecientes) seccionRecientes.style.display = 'block';
        if (paginacionNormal) paginacionNormal.style.display = 'flex';
        
        // Restauramos los textos originales por ID para evitar confusiones
        if (tituloTop10) tituloTop10.innerText = "Top 10 mas vistos de la temporada";
        if (tituloRecientes) tituloRecientes.innerText = "Últimos episodios agregados";
        if (tituloTodos) tituloTodos.innerText = "Todos los Animes";
        
        // Limpiamos la paginación de búsqueda
        const pBusquedaExistente = document.getElementById('paginacion-busqueda');
        if (pBusquedaExistente) pBusquedaExistente.remove();
        const pFiltrosExistente = document.getElementById('paginacion-filtros');
        if (pFiltrosExistente) pFiltrosExistente.remove();

        return cargarHome(); 
    }

    // --- ESTADO: BUSCANDO ---
    // Ocultamos las secciones de la Home
    if (seccionTop10) seccionTop10.style.display = 'none';
    if (seccionRecientes) seccionRecientes.style.display = 'none';
    if (paginacionNormal) paginacionNormal.style.display = 'none';
    
    const pFiltrosExistente = document.getElementById('paginacion-filtros');
    if (pFiltrosExistente) pFiltrosExistente.remove();

    // Estilo de búsqueda Gold
    if (tituloTodos) {
        tituloTodos.innerHTML = `🔍 RASTREANDO: <span style="color:white;">${q.toUpperCase()}</span>`;
    }

    if (listaTodos) {
        listaTodos.innerHTML = `
            <div style="width:100%; text-align:center; padding:30px; animation: slideUp 0.3s ease;">
                <div style="font-size:2.2rem; animation: diceShake 0.5s infinite; display:inline-block;">📡</div>
                <p style="color:var(--gold); font-size:0.7rem; font-weight:900; margin-top:10px; letter-spacing:1px;">
                    FILTRANDO SERVIDORES GLOBALES...
                </p>
            </div>`;
    }

    try {
        // Intentar Jikan primero con fetchWithFallback que automaticamente va a Anilist si falla
        const result = await fetchWithFallback(
            `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&order_by=popularity&sort=asc&page=${paginaBusqueda}`,
            () => searchAnilist(q, paginaBusqueda, 24)
        );

        if (!result.ok) {
            throw new Error(result.error || "La búsqueda no pudo completarse.");
        }

        const data = result.data;
        
        if (data && data.length > 0) {
            renderGrid(data, 'lista-todos');
            // Si vino de Anilist, no hay paginación exacta
            if (result.source === 'jikan') {
                renderPaginacionBusqueda(result.pagination);
            } else {
                // Paginación estimada para Anilist
                renderPaginacionBusqueda({ has_next_page: data.length >= 24, last_visible_page: paginaBusqueda + 1 });
            }
            // Actualizar título para indicar la fuente
            if (tituloTodos && result.source === 'anilist') {
                tituloTodos.innerHTML = `🔍 RASTREANDO: <span style="color:white;">${q.toUpperCase()}</span> <span style="font-size:0.6rem; opacity:0.5;"></span>`;
            }
        } else {
            if (listaTodos) {
                listaTodos.innerHTML = `
                    <div style="width:100%; text-align:center; padding:40px 20px;">
                        <div style="font-size:2.5rem; margin-bottom:15px;">🔍</div>
                        <p style="color:#888; font-size:0.85rem;">No se encontraron resultados para "${q}".</p>
                        <p style="color:#666; font-size:0.75rem; margin-top:5px;">Prueba con otro término de búsqueda.</p>
                    </div>`;
            }
        }
    } catch (err) {
        console.error("Error en búsqueda:", err);
        
        if (listaTodos) {
            const errorMsg = err.name === 'AbortError' 
                ? 'La búsqueda tardó demasiado. Verifica tu conexión.'
                : err.message || 'Error al buscar. Verifica tu conexión a internet.';
            
            listaTodos.innerHTML = `
                <div style="width:100%; text-align:center; padding:40px 20px;">
                    <div style="font-size:2.5rem; margin-bottom:15px;">⚠️</div>
                    <p style="color:#ff6b6b; font-size:0.85rem; margin-bottom:15px;">${errorMsg}</p>
                    <button onclick="buscarAnimeFusion(${pagina})" class="btn-random-gold" style="margin:5px;">🔄 REINTENTAR</button>
                </div>`;
        }
    }
}

// Función auxiliar para los botones de página de la búsqueda
function renderPaginacionBusqueda(info) {
    let contenedorBusqueda = document.getElementById('paginacion-busqueda');
    if (contenedorBusqueda) contenedorBusqueda.remove();

    if (!info.has_next_page && paginaBusqueda === 1) return;

    contenedorBusqueda = document.createElement('div');
    contenedorBusqueda.id = 'paginacion-busqueda';
    contenedorBusqueda.style = "display: flex; justify-content: center; align-items: center; gap: 20px; margin: 30px 0; padding-bottom: 20px;";

    contenedorBusqueda.innerHTML = `
        <button onclick="buscarAnimeFusion(${paginaBusqueda - 1})" class="btn-random-gold" ${paginaBusqueda === 1 ? 'disabled style="opacity:0.5"' : ''}>❮ Anterior</button>
        <span style="color: var(--gold); font-weight: bold; font-size: 1.1rem;">Página ${paginaBusqueda}</span>
        <button onclick="buscarAnimeFusion(${paginaBusqueda + 1})" class="btn-random-gold" ${!info.has_next_page ? 'disabled style="opacity:0.5"' : ''}>Siguiente ❯</button>
    `;

    document.getElementById('lista-todos').after(contenedorBusqueda);
}

window.goldAlert = function({ title = "AVISO", text = "", icon = "⚠️", confirmText = "ACEPTAR", showCancel = false, showInput = false }) {
    return new Promise((resolve) => {
        const modal = document.getElementById('gold-modal');
        const input = document.getElementById('gold-modal-input');
        const titleEl = document.getElementById('gold-modal-title');
        const textEl = document.getElementById('gold-modal-text');
        const iconEl = document.getElementById('gold-modal-icon');
        const btnContainer = document.getElementById('gold-modal-buttons');

        // Configurar contenido
        titleEl.innerText = title;
        textEl.innerText = text;
        iconEl.innerText = icon;
        btnContainer.innerHTML = ""; // Limpiar botones

        // Configurar Input
        input.value = "";
        input.style.display = showInput ? "block" : "none";

        // Botón Confirmar / Enviar
        const btnConfirm = document.createElement('button');
        btnConfirm.innerText = confirmText;
        btnConfirm.style = "background:var(--gold); color:black; border:none; padding:12px 20px; border-radius:8px; font-weight:bold; cursor:pointer; flex:1; transition: 0.2s;";
        btnConfirm.onclick = () => {
            const val = showInput ? input.value : true;
            modal.style.display = 'none';
            resolve(val);
        };

        // Botón Cancelar
        if (showCancel) {
            const btnCancel = document.createElement('button');
            btnCancel.innerText = "CANCELAR";
            btnCancel.style = "background:transparent; color:#fff; border:1px solid #444; padding:12px 20px; border-radius:8px; cursor:pointer; flex:1;";
            btnCancel.onclick = () => {
                modal.style.display = 'none';
                resolve(null); // Devolvemos null si cancela
            };
            btnContainer.appendChild(btnCancel);
        }

        btnContainer.appendChild(btnConfirm);
        
        // Mostrar modal con flex
        modal.style.display = 'flex';
        
        // Auto-foco si hay input
        if(showInput) setTimeout(() => input.focus(), 50);
    });
};

function activarNotificacionesEnVivo() {
    console.log("📡 Conectando con el radar de episodios Gold...");
    
    _db.channel('radar-episodios')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'enlaces_episodios' }, async (payload) => {
        console.log("⚡ ¡Cambio detectado en la base de datos!", payload);
        const nuevoEp = payload.new;
        
        // Para que la notificación sea "Gold", necesitamos el nombre del anime (Jikan)
        try {
            const res = await fetch(`https://api.jikan.moe/v4/anime/${nuevoEp.anime_id}`);
            const json = await res.json();

            if (!json || !json.data) throw new Error("Anime no encontrado");

            const nombreAnime = json.data.title || "Nuevo Anime";
            const imagen = json.data.images?.jpg?.image_url;

            lanzarNotificacionSistema(
                `¡NUEVO EPISODIO! 🏆`,
                `${nombreAnime} - Episodio ${nuevoEp.episodio_num} ya disponible en AiduMe.`,
                imagen,
                nuevoEp.anime_id
            );
        } catch (e) {
            console.warn("Fallo al obtener datos de Jikan para notificación:", e);
            lanzarNotificacionSistema(`¡NUEVO ESTRENO! ⚡`, `Se ha subido el episodio ${nuevoEp.episodio_num} de un nuevo anime.`);
        }
    })
    .subscribe();
}

async function lanzarNotificacionSistema(titulo, cuerpo, imagen, animeId = null) {
    if (Notification.permission === "granted") {
        const opciones = {
            body: cuerpo,
            icon: imagen || 'logo-grande.png',
            badge: 'logo-grande.png',
            vibrate: [300, 100, 300],
            tag: 'nuevo-episodio', // Evita que se amontonen muchas notificaciones iguales
            renotify: true,        // Hace que el móvil vibre de nuevo si llega otra
            data: {
                url: animeId ? `/?openAnime=${animeId}` : '/'
            }
        };
        
        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.ready;
            reg.showNotification(titulo, opciones);
        } else {
            new Notification(titulo, opciones);
        }
    }
}

// Mantener tus disparadores vinculados a la nueva función
function buscarAnime() { buscarAnimeFusion(); }
function buscarAnimeLive() { buscarAnimeFusion(); }

/**
 * Actualiza el contador total de mensajes privados no leídos en la barra de navegación
 */
async function actualizarNotificacionesPerfil() {
    if (!currentUser) return;
    try {
        const { count, error } = await _db.from('chat_privado')
            .select('*', { count: 'exact', head: true })
            .ilike('receptor', currentUser)
            .eq('leido', false);

        if (error) throw error;

        // Localizamos el botón de "Perfil" en la barra inferior por su atributo onclick
        const navItems = document.querySelectorAll('.nav-item');
        const profileNav = Array.from(navItems).find(item => {
            const click = item.getAttribute('onclick') || "";
            return click.includes("'perfil'") || click.includes('"perfil"');
        });

        if (profileNav) {
            let badge = profileNav.querySelector('.nav-badge-gold');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'nav-badge-gold';
                profileNav.style.position = 'relative'; // Aseguramos el anclaje
                profileNav.appendChild(badge);
            }

            if (count > 0) {
                badge.innerText = count > 99 ? "99+" : count;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
    } catch (err) {
        console.error("Error al actualizar badge de perfil:", err);
    }
}

/**
 * Escucha cambios en chat_privado para actualizar el badge de navegación en tiempo real
 */
function escucharNotificacionesGlobales() {
    if (!currentUser) return;
    _db.channel('badge-notif-global')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_privado' }, payload => {
        const m = payload.new || payload.old;
        // Si el mensaje es para mí, actualizo el contador global de la barra
        if (m && String(m.receptor).trim().toLowerCase() === currentUser.trim().toLowerCase()) {
            actualizarNotificacionesPerfil();
        }
    }).subscribe();
}

/**
 * Inicia el sistema de reconocimiento de voz para buscar animes
 */
async function iniciarBusquedaVoz() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!Recognition) {
        return goldAlert({ 
            title: "NO SOPORTADO", 
            text: "Tu navegador no es compatible con la búsqueda por voz. Prueba en Chrome o Edge.", 
            icon: "🎙️" 
        });
    }

    const rec = new Recognition();
    rec.lang = 'es-ES'; // Configurado para español
    rec.continuous = false;
    rec.interimResults = false;

    const btn = document.getElementById('btn-voice-search');
    const input = document.getElementById('busqueda');

    rec.onstart = () => {
        if (btn) btn.classList.add('recording');
        if (input) input.placeholder = "Escuchando...";
    };

    rec.onresult = (event) => {
        const texto = event.results[0][0].transcript;
        if (input) {
            input.value = texto;
            buscarAnimeFusion(); // Ejecuta la búsqueda automáticamente
        }
    };

    rec.onend = () => {
        if (btn) btn.classList.remove('recording');
        if (input && input.placeholder === "Escuchando...") {
            input.placeholder = "Buscar anime...";
        }
    };

    rec.start();
}

// ===== SISTEMA DE MENTORÍA =====

/**
 * Carga y renderiza la sección de mentoría en el perfil
 */
async function cargarSeccionMentoria(perfil) {
    const seccion = document.getElementById('seccion-mentoria');
    const contenido = document.getElementById('contenido-mentoria');
    if (!seccion || !contenido || !currentUser) return;

    const esMismoUsuario = (currentUser === perfil.nombre);
    if (!esMismoUsuario) {
        seccion.style.display = 'none';
        return;
    }

    seccion.style.display = 'block';
    let html = "";

    try {
        // 1. Verificar si el usuario ya tiene mentoría activa como mentor o mentee
        const { data: mentoriasActivas } = await _db.from('mentorias')
            .select('*')
            .or(`and(mentor_nombre.ilike."${currentUser}",estado.eq.activa),and(mentee_nombre.ilike."${currentUser}",estado.eq.activa)`);

        const mentoriaActiva = mentoriasActivas && mentoriasActivas.length > 0 ? mentoriasActivas[0] : null;

        if (mentoriaActiva) {
            const soyMentor = mentoriaActiva.mentor_nombre.toLowerCase() === currentUser.toLowerCase();
            const otroUsuario = soyMentor ? mentoriaActiva.mentee_nombre : mentoriaActiva.mentor_nombre;
            
            // Obtener datos del otro usuario
            const { data: otroPerfil } = await _db.from('perfiles')
                .select('nivel, avatar_id, online, ultima_conexion')
                .ilike('nombre', otroUsuario)
                .single();

            const avatarUrl = otroPerfil ? (() => {
                const todos = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
                const av = todos.find(a => a.id === String(otroPerfil.avatar_id || '1'));
                return av ? av.img : `https://api.dicebear.com/7.x/avataaars/svg?seed=${otroUsuario}`;
            })() : '';

            const badgeRol = soyMentor ? '🎓 MENTOR' : '📖 APRENDIZ';
            const badgeColor = soyMentor ? '#00d4ff' : '#ffd700';

            html += `
                <div class="mentor-card" style="border-color: ${badgeColor};">
                    <div class="mentor-header">
                        <img src="${avatarUrl}" class="mentor-avatar" style="border-color: ${badgeColor};">
                        <div>
                            <span class="mentor-badge" style="border-color: ${badgeColor}; color: ${badgeColor};">${badgeRol} ACTIVO</span>
                            <div class="mentor-name" onclick="verPerfilAjeno('${otroUsuario}')">@${otroUsuario}</div>
                        </div>
                    </div>
                    <div class="mentor-stats">Nivel: ${otroPerfil?.nivel || '?'} • Recompensas: ${mentoriaActiva.recompensas_otorgadas || 0}</div>
                </div>`;
        } else {
            // 2. No tiene mentoría activa - Mostrar opciones
            const { data: solicitudesPendientes } = await _db.from('mentorias')
                .select('*')
                .or(`and(mentor_nombre.ilike."${currentUser}",estado.eq.pendiente),and(mentee_nombre.ilike."${currentUser}",estado.eq.pendiente)`)
                .order('fecha_solicitud', { ascending: false });

            // Mostrar solicitudes pendientes
            if (solicitudesPendientes && solicitudesPendientes.length > 0) {
                html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold;">SOLICITUDES PENDIENTES:</p>`;
                solicitudesPendientes.forEach(s => {
                    const soyMentor = s.mentor_nombre.toLowerCase() === currentUser.toLowerCase();
                    const otroUser = soyMentor ? s.mentee_nombre : s.mentor_nombre;
                    
                    html += `
                        <div class="mentor-solicitud-item">
                            <span class="solicitud-info">
                                ${soyMentor ? '📖' : '🎓'} <b>@${otroUser}</b> quiere ser tu ${soyMentor ? 'aprendiz' : 'mentor'}
                            </span>
                            <div style="display:flex; gap:5px;">
                                <button onclick="aceptarMentoria(${s.id})" class="btn-random-gold" style="padding:4px 8px; margin:0;">✔️</button>
                                <button onclick="rechazarMentoria(${s.id})" class="btn-random-gold" style="padding:4px 8px; margin:0; border-color:red; color:red;">❌</button>
                            </div>
                        </div>`;
                });
                html += `<div style="border-top:1px solid rgba(255,215,0,0.1); margin:10px 0;"></div>`;
            }

            // Opción para registrarse como mentor (requiere nivel >= 5)
            const nivelSuficiente = (perfil.nivel || 0) >= 5;
            const esMentorRegistrado = perfil.es_mentor;

            if (nivelSuficiente && !esMentorRegistrado) {
                html += `
                    <button onclick="registrarComoMentor()" class="btn-mentor">
                        🎓 CONVERTIRSE EN MENTOR
                    </button>
                    <p class="mentor-info-text">Como Mentor, otros usuarios podrán solicitarte como su guía. Ganarás fichas cuando tu aprendiz progrese.</p>`;
            } else if (esMentorRegistrado) {
                html += `
                    <button class="btn-mentor active-mentor" onclick="desactivarModoMentor()">
                        🎓 MENTOR ACTIVO
                    </button>
                    <p class="mentor-info-text">Estás disponible como mentor. Los aprendices pueden solicitarte. Toca para desactivar.</p>`;
                
                // Mostrar lista de mentores disponibles
                html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold; margin-top:10px;">🔍 BUSCAR MENTOR:</p>`;
                html += await buscarMentoresDisponiblesHTML();
            } else {
                html += `<p class="mentor-info-text">⭐ Necesitas ser Nivel 5 para convertirte en Mentor.</p>`;
                html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold; margin-top:10px;">🔍 BUSCAR MENTOR:</p>`;
                html += await buscarMentoresDisponiblesHTML();
            }

            if (!nivelSuficiente && !esMentorRegistrado) {
                html += `<p class="mentor-info-text">📖 También puedes buscar un mentor que te guíe en tu experiencia AiduMe.</p>`;
            }
        }

    } catch (err) {
        console.error("Error cargando sección mentoría:", err);
        html = `<p class="mentor-info-text">Error al cargar el sistema de mentoría.</p>`;
    }

    contenido.innerHTML = html;
}

/**
 * Busca mentores disponibles y devuelve HTML
 */
async function buscarMentoresDisponiblesHTML() {
    try {
        const { data: mentores } = await _db.from('perfiles')
            .select('nombre, nivel, avatar_id, online')
            .eq('es_mentor', true)
            .neq('nombre', currentUser)
            .limit(10);

        if (!mentores || mentores.length === 0) {
            return `<p class="mentor-info-text">No hay mentores disponibles en este momento.</p>`;
        }

        const todos = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
        let html = "";
        mentores.forEach(m => {
            const av = todos.find(a => a.id === String(m.avatar_id || '1'));
            const urlAv = av ? av.img : `https://api.dicebear.com/7.x/avataaars/svg?seed=${m.nombre}`;
            html += `
                <div class="mentor-card">
                    <div class="mentor-header">
                        <span class="${m.online ? 'online-dot' : 'offline-dot'}" style="margin-right:8px;"></span>
                        <img src="${urlAv}" class="mentor-avatar">
                        <div>
                            <div class="mentor-name" onclick="verPerfilAjeno('${m.nombre}')">@${m.nombre}</div>
                            <div class="mentor-stats">Nivel ${m.nivel || 1}</div>
                        </div>
                    </div>
                    <button onclick="solicitarMentor('${m.nombre}')" class="btn-mentor" style="width:100%;">
                        📖 SOLICITAR COMO MENTOR
                    </button>
                </div>`;
        });
        return html;
    } catch (err) {
        console.error("Error buscando mentores:", err);
        return `<p class="mentor-info-text">Error al buscar mentores.</p>`;
    }
}

/**
 * Registra al usuario como mentor disponible
 */
async function registrarComoMentor() {
    if (!currentUser) return;
    
    const confirmar = await goldAlert({
        title: "SER MENTOR",
        text: "¿Quieres convertirte en Mentor de Oro? Otros usuarios podrán solicitarte como guía. Ganarás recompensas cuando tus aprendices progresen.",
        icon: "🎓",
        showCancel: true,
        confirmText: "SÍ, SER MENTOR"
    });
    
    if (confirmar) {
        await _db.from('perfiles').update({ es_mentor: true }).ilike('nombre', currentUser);
        goldAlert({ title: "MENTOR ACTIVADO", text: "¡Ya eres un Mentor de Oro! Los aprendices podrán encontrarte.", icon: "🎓" });
        actualizarPerfilDesdeSQL();
    }
}

/**
 * Desactiva el modo mentor
 */
async function desactivarModoMentor() {
    if (!currentUser) return;
    const confirmar = await goldAlert({ title: "DESACTIVAR MENTOR", text: "¿Dejar de estar disponible como mentor?", icon: "❓", showCancel: true });
    if (confirmar) {
        await _db.from('perfiles').update({ es_mentor: false }).ilike('nombre', currentUser);
        goldAlert({ title: "MENTOR DESACTIVADO", text: "Ya no aparecerás en la lista de mentores.", icon: "👋" });
        actualizarPerfilDesdeSQL();
    }
}

/**
 * Solicita ser aprendiz de un mentor
 */
async function solicitarMentor(nombreMentor) {
    if (!currentUser) return;
    
    const { data: existente } = await _db.from('mentorias')
        .select('id')
        .or(`and(mentor_nombre.ilike."${nombreMentor}",mentee_nombre.ilike."${currentUser}"),and(mentor_nombre.ilike."${currentUser}",mentee_nombre.ilike."${nombreMentor}")`);
    
    if (existente && existente.length > 0) {
        return goldAlert({ title: "YA EXISTE", text: "Ya hay una relación de mentoría entre ustedes.", icon: "📂" });
    }

    const { error } = await _db.from('mentorias').insert([{
        mentor_nombre: nombreMentor.trim(),
        mentee_nombre: currentUser.trim(),
        estado: 'pendiente',
        fecha_solicitud: new Date().toISOString()
    }]);

    if (error) {
        console.error("Error al solicitar mentor:", error);
        return goldAlert({ title: "ERROR", text: "No se pudo enviar la solicitud.", icon: "❌" });
    }

    goldAlert({ title: "SOLICITUD ENVIADA", text: `Has solicitado a @${nombreMentor} como mentor. Espera su respuesta.`, icon: "📨" });
    actualizarPerfilDesdeSQL();
}

/**
 * Acepta una mentoría
 */
async function aceptarMentoria(id) {
    await _db.from('mentorias').update({ estado: 'activa', fecha_inicio: new Date().toISOString() }).eq('id', id);
    goldAlert({ title: "MENTORÍA ACTIVADA", text: "Ahora tienes una relación de mentoría activa.", icon: "🤝" });
    actualizarPerfilDesdeSQL();
}

/**
 * Rechaza una mentoría
 */
async function rechazarMentoria(id) {
    await _db.from('mentorias').delete().eq('id', id);
    goldAlert({ title: "RECHAZADA", text: "La solicitud de mentoría ha sido rechazada.", icon: "❌" });
    actualizarPerfilDesdeSQL();
}

/**
 * Otorga recompensas al mentor cuando el mentee progresa
 */
async function verificarRecompensaMentor(xpGanada) {
    if (!currentUser) return;

    try {
        // Buscar si el usuario actual es mentee de alguien
        const { data: mentorias } = await _db.from('mentorias')
            .select('*')
            .ilike('mentee_nombre', currentUser)
            .eq('estado', 'activa');

        if (!mentorias || mentorias.length === 0) return;

        const mentoria = mentorias[0];
        const mentorName = mentoria.mentor_nombre;

        // Cada 10 XP ganados, el mentor recibe 5 fichas
        const nuevasRecompensas = Math.floor(xpGanada / 10);
        if (nuevasRecompensas > 0) {
            // Dar fichas al mentor
            const { data: mentorPerfil } = await _db.from('perfiles')
                .select('aidufichas')
                .ilike('nombre', mentorName)
                .single();

            if (mentorPerfil) {
                const nuevasFichas = (mentorPerfil.aidufichas || 0) + (nuevasRecompensas * 5);
                await _db.from('perfiles').update({ aidufichas: nuevasFichas }).ilike('nombre', mentorName);
            }

            // Actualizar contador de recompensas
            await _db.from('mentorias')
                .update({ recompensas_otorgadas: (mentoria.recompensas_otorgadas || 0) + nuevasRecompensas })
                .eq('id', mentoria.id);

            console.log(`🎓 Recompensa de mentoría: ${nuevasRecompensas * 5} fichas para ${mentorName}`);
        }
    } catch (err) {
        console.error("Error en verificarRecompensaMentor:", err);
    }
}

/**
 * Obtiene el objeto amigos_data desde la columna JSONB de perfiles
 */
async function obtenerAmigosData(usuario) {
    try {
        const { data, error } = await _db
            .from('perfiles')
            .select('amigos_data')
            .ilike('nombre', usuario.trim())
            .single();

        if (error) {
            console.error(`Error al obtener amigos_data para ${usuario}:`, error);
            return { amigos: [], solicitudes_enviadas: [], solicitudes_recibidas: [] };
        }

        // Si la columna está vacía o es null, devolvemos la estructura limpia por defecto
        return data?.amigos_data || { amigos: [], solicitudes_enviadas: [], solicitudes_recibidas: [] };
    } catch (err) {
        console.error("Excepción en obtenerAmigosData:", err);
        return { amigos: [], solicitudes_enviadas: [], solicitudes_recibidas: [] };
    }
}

/**
 * Guarda el objeto amigos_data actualizado en la columna JSONB de perfiles
 */
async function guardarAmigosData(usuario, dataAmigos) {
    try {
        const { error } = await _db
            .from('perfiles')
            .update({ amigos_data: dataAmigos })
            .ilike('nombre', usuario.trim());

        if (error) {
            console.error(`Error al guardar amigos_data para ${usuario}:`, error);
            throw error;
        }
        return true;
    } catch (err) {
        console.error("Excepción en guardarAmigosData:", err);
        throw err;
    }
}

const METADATA_CACHE_KEY = 'aidume_anime_metadata_cache';
const CACHE_EXPIRATION_MS = 5 * 24 * 60 * 60 * 1000; // 7 días en milisegundos

function obtenerCacheMetadata() {
    try {
        const cache = localStorage.getItem(METADATA_CACHE_KEY);
        return cache ? JSON.parse(cache) : {};
    } catch (e) {
        console.error("Error al leer localStorage:", e);
        return {};
    }
}

function guardarCacheMetadata(cache) {
    try {
        localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        console.error("Error al escribir en localStorage:", e);
    }
}

async function fetchJikanBatchConCache(ids) {
    const cache = obtenerCacheMetadata();
    const mapResultados = {};
    const idsFaltantes = [];
    const ahora = Date.now();

    ids.forEach(id => {
        const itemGuardado = cache[id];
        
        // 💡 VERIFICACIÓN: Si existe y NO ha expirado, lo usamos directo de la caché
        if (itemGuardado && itemGuardado.expira_en && ahora < itemGuardado.expira_en) {
            mapResultados[id] = itemGuardado.data;
        } else {
            // Si no existe, o si ya pasaron los 7 días, lo mandamos a actualizar
            idsFaltantes.push(id);
        }
    });

    if (idsFaltantes.length === 0) {
        return mapResultados;
    }

    const delay = ms => new Promise(res => setTimeout(res, ms));

    for (const id of idsFaltantes) {
        try {
            await delay(370); // Retraso seguro para Jikan
            const res = await fetch(`https://api.jikan.moe/v4/anime/${id}`);
            if (res.ok) {
                const json = await res.json();
                if (json.data) {
                    const infoConExpiracion = {
                        data: json.data, // Guardamos la data completa de Jikan
                        expira_en: ahora + CACHE_EXPIRATION_MS // Seteamos la fecha límite (hoy + 7 días)
                    };

                    mapResultados[id] = json.data;
                    cache[id] = infoConExpiracion;
                }
            }
        } catch (err) {
            console.error(`Error de red con Jikan para ID ${id}:`, err);
            
            // 🛡️ PLAN B: Si la API falla (por ejemplo, sin internet), pero teníamos
            // un dato viejo expirado en caché, lo usamos temporalmente para no mostrar la pantalla rota
            if (cache[id]) {
                console.warn(`Usando caché expirada de forma temporal para ID ${id}`);
                mapResultados[id] = cache[id].data;
            }
        }
    }

    guardarCacheMetadata(cache);
    return mapResultados;
}

// ==========================================
// 1. FUNCIÓN PUENTE PARA REANUDAR EL ANIME
// ==========================================
async function continuarViendoAnime(animeId, episodioNum, segundos) {
    try {
        console.log(`🚀 [Continuar Viendo] Recuperando anime ID ${animeId} para reanudar en Ep ${episodioNum} (${segundos}s)`);
        
        // 1. Consultamos a la API de Jikan para obtener el objeto completo del anime
        const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}`);
        const fullData = await res.json();
        
        if (!fullData || !fullData.data) {
            throw new Error("No se pudo obtener la información del anime desde Jikan.");
        }
        
        const animeObjeto = fullData.data;

        // 2. Ejecutamos tu función showDetails para renderizar la vista de detalles del anime
        await showDetails(animeObjeto);
        
        // 3. Esperamos a que se dibuje la interfaz en pantalla y lanzamos el reproductor
        setTimeout(() => {
            const nombreFinal = animeObjeto.title;
            // Llamamos a la versión unificada de reproducirEpisodio pasándole el segundo exacto
            reproducirEpisodio(nombreFinal, episodioNum, segundos);
        }, 700); 

    } catch (error) {
        console.error("🚨 Error en continuarViendoAnime:", error);
        alert("No se pudo reanudar el episodio. Intenta abrir el anime manualmente.");
    }
}

// ==========================================
// 2. RENDERIZADO DINÁMICO DE LA SECCIÓN
// ==========================================
async function cargarSeccionContinuarViendo() {
    const seccionContainer = document.getElementById('seccion-continuar-viendo');
    const listaContainer = document.getElementById('lista-continuar-viendo');
    
    if (!seccionContainer || !listaContainer) return;
    if (!currentUser) {
        seccionContainer.style.display = 'none';
        return;
    }

    try {
        console.log("🔄 [Continuar Viendo] Cargando progresos desde la DB...");

        const { data: progresos, error } = await _db
            .from('progreso_reproduccion')
            .select('*')
            .eq('usuario', currentUser)
            .order('fecha_actualizacion', { ascending: false })
            .limit(5);

        if (error) throw error;

        if (!progresos || progresos.length === 0) {
            seccionContainer.style.display = 'none';
            return;
        }

        seccionContainer.style.display = 'block';
        listaContainer.innerHTML = '';

        const promesasDetalles = progresos.map(async (progreso) => {
            try {
                const res = await fetch(`https://api.jikan.moe/v4/anime/${progreso.anime_id}`);
                const resJson = await res.json();
                return { progreso, anime: resJson.data };
            } catch (err) {
                return { progreso, anime: null };
            }
        });

        const resultados = await Promise.all(promesasDetalles);
        let html = '';

        resultados.forEach(({ progreso, anime }) => {
            if (!anime) return;

            const nombreAnime = anime.titles ? (anime.titles.find(t => t.type === 'Spanish')?.title || anime.title) : anime.title;
            const imagenUrl = anime.images?.jpg?.image_url || 'img/placeholder.jpg';
            
            const minutos = Math.floor(progreso.progreso_segundos / 60);
            const segundosRestantes = progreso.progreso_segundos % 60;
            const tiempoFormateado = minutos > 0 ? `${minutos}m ${segundosRestantes}s` : `${segundosRestantes}s`;

            // HTML con etiqueta <img> para mayor persistencia
            html += `
                <div class="continuar-viendo-card" 
                     onclick="continuarViendoAnime(${progreso.anime_id}, ${progreso.episodio_num}, ${progreso.progreso_segundos})"
                     style="display: block !important; position: relative !important; cursor: pointer !important;">
                    
                    <img src="${imagenUrl}" style="position: absolute !important; width: 100% !important; height: 100% !important; object-fit: cover !important; z-index: 0 !important;">
                    
                    <div class="continuar-viendo-overlay" style="position: absolute !important; inset: 0 !important; background: rgba(0,0,0,0.5) !important; display: flex !important; align-items: center !important; justify-content: center !important; z-index: 2 !important;">
                        <div class="play-btn-circle" style="width: 45px !important; height: 45px !important; border-radius: 50% !important; background: var(--gold) !important; color: #000 !important; display: flex !important; align-items: center !important; justify-content: center !important; font-size: 1.2rem !important; font-weight: bold !important;">▶</div>
                    </div>
                    
                    <div class="continuar-viendo-info" style="position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; padding: 12px !important; z-index: 3 !important;">
                        <span class="badge-ep-gold" style="background: var(--gold) !important; color: #000 !important; font-size: 0.75rem !important; font-weight: bold !important; padding: 3px 8px !important; border-radius: 4px !important;">Ep ${progreso.episodio_num} • ${tiempoFormateado}</span>
                        <h4 class="continuar-viendo-titulo" style="margin: 5px 0 0 0 !important; color: #fff !important; font-size: 0.95rem !important; text-shadow: 1px 1px 2px #000 !important;">${nombreAnime}</h4>
                    </div>
                </div>
            `;
        });

        listaContainer.innerHTML = html;

    } catch (err) {
        console.error("🚨 Error:", err);
        seccionContainer.style.display = 'none';
    }
}