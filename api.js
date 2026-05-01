let currentAnime = null;
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

// Lista de palabras que activarán la alerta roja
const PALABRAS_PROHIBIDAS = ["insulto1", "insulto2", "spam", "ofensa"];

function parsearMensajeParaStickers(texto) {
    if (!texto) return "";
    const regex = /\[STK:([^\]]+)\]/g;
    return texto.replace(regex, '<img src="$1" class="chat-sticker">');
}

async function initApp() {
    await cargarDuelo();
    cargarHome();
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

    // Auto-abrir anime desde notificación
    const params = new URLSearchParams(window.location.search);
    const openId = params.get('openAnime');
    if (openId) {
        // Limpiamos la URL para que no se repita al recargar
        window.history.replaceState(null, null, window.location.pathname);
        showDetails({ mal_id: parseInt(openId) });
    }
}

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
    // Cambia esto en cargarHome() para que sea el Top de la Temporada Actual
const r = await fetch('https://api.jikan.moe/v4/seasons/now?limit=10&order_by=members&sort=desc');
    const j = await r.json();
    renderGrid(j.data, 'lista');
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
        if (profileData && (profileData.rol === 'dueño' || profileData.rol === 'admin')) {
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
            // A. Cargar progreso de vistos
            if (currentUser) {
                const { data: vistos } = await _db
                    .from('episodios_vistos')
                    .select('episodio_num')
                    .eq('usuario_nombre', currentUser)
                    .eq('anime_id', a.mal_id);
                console.log(`📚 Episodios vistos cargados para ${currentUser} (Anime ID ${a.mal_id}):`, vistos);
                if (vistos) listaVistos = vistos.map(v => v.episodio_num);
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
    const nombreLimpio = nombreFinal.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    for (let i = 1; i <= cantidad; i++) {
        const isChecked = listaVistos.includes(i) ? 'checked' : '';
        html += `
            <div class="episode-row">
                <div class="ep-info" onclick="reproducirEpisodio('${nombreLimpio}', ${i})">
                    <span class="play-icon">▶</span>
                    <div>
                        <div class="ep-name">${nombreFinal}</div>
                        <div class="ep-num">Episodio ${i}</div>
                    </div>
                </div>
                
                <div class="ep-check-area" style="display: flex !important; flex-direction: row !important; align-items: center !important; gap: 8px; min-width: 100px; justify-content: flex-end;">
                    
                    <span onclick="event.stopPropagation(); reportarFalla(${i}, '${nombreLimpio}')" 
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
    // 1. Detectar idioma (tu lógica actual)
    const botones = Array.from(document.querySelectorAll('button'));
    const btnLatino = botones.find(b => b.innerText.includes('LATINO'));
    
    const esLatinoActivo = btnLatino && (
        btnLatino.style.background.includes('rgb(255, 193, 7)') || 
        btnLatino.classList.contains('active') ||
        window.getComputedStyle(btnLatino).backgroundColor === 'rgb(255, 193, 7)'
    );

    const idiomaActual = esLatinoActivo ? 'Latino' : 'Subtitulado';

    // --- REEMPLAZO DEL CONFIRM POR GOLD ALERT ---
    const confirmar = await goldAlert({
        title: "REPORTAR FALLA",
        text: `¿Reportar el episodio ${numEpisodio} (${idiomaActual}) de "${nombreAnime}" como caído?`,
        icon: "🚩",
        showCancel: true,
        confirmText: "SÍ, REPORTAR"
    });

    if (!confirmar) return;

    try {
        const { error } = await _db
            .from('reportes_episodios')
            .insert([{
                usuario: currentUser,
                anime_id: currentAnime.mal_id,
                anime_nombre: nombreAnime,
                episodio: numEpisodio,
                idioma: idiomaActual,
                fecha: new Date().toISOString()
            }]);

        if (error) throw error;

        // --- REEMPLAZO DEL ALERT DE ÉXITO ---
        goldAlert({
            title: "ENVIADO",
            text: `El reporte del episodio ${numEpisodio} (${idiomaActual}) ha sido enviado. ¡Gracias por ayudar!`,
            icon: "✔️",
            confirmText: "GENIAL"
        });

    } catch (err) {
        console.error("Error al reportar:", err);
        
        // --- REEMPLAZO DEL ALERT DE ERROR ---
        goldAlert({
            title: "ERROR",
            text: "No pudimos enviar el reporte en este momento. Inténtalo más tarde.",
            icon: "❌",
            confirmText: "ENTENDIDO"
        });
    }
}

/** --- SISTEMA DE AMIGOS Y CHAT PRIVADO --- **/

async function enviarSolicitudAmistad(usuarioDestino) {
    if (!currentUser) return;
    if (currentUser.trim().toLowerCase() === usuarioDestino.trim().toLowerCase()) return;

    const { error } = await _db.from('amistades').insert([
        { usuario_envia: currentUser.trim(), usuario_recibe: usuarioDestino.trim(), estado: 'pendiente' }
    ]);
    if (error) {
        console.error("Error al enviar solicitud:", error.message);
        if (error.code === '23505') { // Código de error para violación de restricción única
            goldAlert({ title: "SOLICITUD PENDIENTE", text: "Ya existe una solicitud de amistad o ya son amigos.", icon: "📨" });
        } else {
            goldAlert({ title: "ERROR", text: "No se pudo enviar la solicitud: " + error.message, icon: "❌" });
        }
    } else {
        goldAlert({ title: "SOLICITUD ENVIADA", text: `Has invitado a @${usuarioDestino} a ser tu amigo.`, icon: "✨" });
        actualizarPerfilDesdeSQL(usuarioDestino);
    }
}

/**
 * Escucha en tiempo real si alguien envía una solicitud al usuario actual
 */
function escucharSolicitudesAmistad() {
    if (!currentUser) return;

    _db.channel('amistades-radar')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'amistades' }, payload => {
        const s = payload.new;
        // Comprobamos si la solicitud es para mí
        if (s.usuario_recibe.trim().toLowerCase() === currentUser.trim().toLowerCase() && s.estado === 'pendiente') {
            reproducirSonidoAnime();
            goldAlert({
                title: "NUEVA SOLICITUD",
                text: `@${s.usuario_envia} quiere ser tu amigo.`,
                icon: "👥"
            });
            // Si el usuario está viendo su propio perfil, refrescamos la lista automáticamente
            const seccionAmigos = document.getElementById('seccion-amigos-perfil');
            if (seccionAmigos && seccionAmigos.style.display !== 'none') {
                actualizarPerfilDesdeSQL();
            }
        }
    }).subscribe();
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
 * Verifica si hay una nueva versión de la aplicación disponible y la recarga si es necesario.
 */
async function checkForAppUpdate() {
    try {
        const { data } = await _db.from('app_settings').select('value').eq('key', 'app_version').single();
        if (data && data.value && data.value !== lastAppVersionChecked) {
            lastAppVersionChecked = data.value;
            console.log("🚀 Nueva versión detectada. Recargando aplicación...");
            location.reload(true); // Recarga forzada, ignorando caché
        }
    } catch (err) { /* Ignorar errores, la app seguirá funcionando */ }
}

async function gestionarSolicitud(id, accion, nombreOtro) {
    if (accion === 'aceptar') {
        await _db.from('amistades').update({ estado: 'aceptada' }).eq('id', id);
        goldAlert({ title: "¡NUEVO AMIGO!", text: `Ahora puedes chatear privado con @${nombreOtro}`, icon: "🤝" });
    } else {
        await _db.from('amistades').delete().eq('id', id);
    }
    actualizarPerfilDesdeSQL();
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
            ? `<span class="seen-icon ${m.leido ? 'visto' : ''}">${m.leido ? '✔️✔️' : '✔️'}</span>` 
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
                    const checkIcon = esMio ? `<span class="seen-icon ${m.leido ? 'visto' : ''}">${m.leido ? '✔️✔️' : '✔️'}</span>` : '';
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
        const { data: solicitudes } = await _db.from('amistades').select('*').ilike('usuario_recibe', myUser).eq('estado', 'pendiente');
        const { data: amigos1 } = await _db.from('amistades').select('usuario_recibe').ilike('usuario_envia', myUser).eq('estado', 'aceptada');
        const { data: amigos2 } = await _db.from('amistades').select('usuario_envia').ilike('usuario_recibe', myUser).eq('estado', 'aceptada');

        console.log("👥 Solicitudes pendientes:", solicitudes);

        let html = "";
        if (solicitudes?.length > 0) {
            html += `<p style="color:var(--gold); font-size:0.7rem; font-weight:bold;">SOLICITUDES PENDIENTES:</p>`;
            solicitudes.forEach(s => {
                html += `
                <div class="friend-item">
                    <span style="font-size:0.8rem;">@${s.usuario_envia}</span>
                    <div style="display:flex; gap:5px;">
                        <button onclick="gestionarSolicitud(${s.id}, 'aceptar', '${s.usuario_envia}')" class="btn-random-gold" style="padding:4px 8px; margin:0;">✔️</button>
                        <button onclick="gestionarSolicitud(${s.id}, 'rechazar')" class="btn-random-gold" style="padding:4px 8px; margin:0; border-color:red; color:red;">❌</button>
                    </div>
                </div>`;
            });
        }

        const nombresAmigos = [...new Set([...(amigos1?.map(a => a.usuario_recibe) || []), ...(amigos2?.map(a => a.usuario_envia) || [])])];
        console.log("🤝 Nombres de amigos:", nombresAmigos);
        
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
                        else if (diffMins < 1440) {
                            // Si fue hoy, mostramos la hora exacta en formato local (24hs)
                            const horaLocal = fechaObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                            etiquetaTiempo = `Hoy ${horaLocal}`;
                        }
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
                    <button onclick="cargarChatPrivado('${amigo}')" class="btn-random-gold" style="padding:4px 8px; margin:0;">💬 Chat</button>
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

        while (nuevaXP >= 3) {
            nuevaXP -= 3;
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
            ganarRecompensaGold({ xp: 1, fichas: 10, silencioso: false });
            console.log("💎 Recompensa por fidelidad otorgada: 1XP + 10 Aidufichas");
        }
    }, 3600000);
}

/**
 * Gestiona el guardado real en la base de datos y otorga premios.
 */
async function toggleEpisodioVisto(animeId, epNum, checkbox) {
    if (!currentUser) return goldAlert({ text: "Inicia sesión para guardar tu progreso", icon: "👤" });

    try {
        if (checkbox.checked) {
            const { error } = await _db.from('episodios_vistos').insert([{
                usuario_nombre: currentUser,
                anime_id: animeId,
                episodio_num: epNum
            }]);
            if (error) throw error;

            console.log(`✅ Guardado en DB: Anime ${animeId}, Ep ${epNum}`);
            ganarRecompensaGold({ xp: 1, fichas: 2 }); 
        } else {
            const { error } = await _db.from('episodios_vistos').delete()
                .eq('usuario_nombre', currentUser)
                .eq('anime_id', animeId)
                .eq('episodio_num', epNum);
            if (error) throw error;

            console.log(`❌ Eliminado de DB: Anime ${animeId}, Ep ${epNum}`);
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
            alert("Ya has calificado este anime. ¡Tu voto es permanente!");
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
        
    } catch (err) {
        console.error("Error al votar:", err.message);
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
    const semanaActual = getWeekNumber(new Date());
    let votosTotales = [0, 0]; // Para guardar los resultados y comparar

    for (let i = 0; i < 2; i++) {
        const { count, error } = await _db
            .from('torneo_votos')
            .select('*', { count: 'exact', head: true })
            .eq('anime_id', duelAnimes[i].mal_id)
            .eq('semana_voto', semanaActual);
        
        if (!error) {
            // 1. Cálculo de votos con la base fija
            const baseFija = (duelAnimes[i].mal_id % 100) + 400;
            votosTotales[i] = baseFija + (count || 0);
            
            // 2. Actualizar el texto en el HTML
            const labelVotos = document.getElementById(`v${i+1}`);
            if (labelVotos) labelVotos.innerText = votosTotales[i] + " votos";
        }
    }

    // --- NUEVO: LÓGICA DE BRILLO DORADO (WINNER GLOW) ---
    const items = document.querySelectorAll('.battle-item');
    
    if (items.length >= 2) {
        // Limpiamos la clase de ambos para re-evaluar el ganador
        items[0].classList.remove('winner-glow');
        items[1].classList.remove('winner-glow');

        // Aplicamos el brillo infinito al que tenga más votos
        if (votosTotales[0] > votosTotales[1]) {
            items[0].classList.add('winner-glow');
        } else if (votosTotales[1] > votosTotales[0]) {
            items[1].classList.add('winner-glow');
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

    const semanaActual = getWeekNumber(new Date());

    try {
        // 1. Verificar límites de votos y obtener saldo actual de fichas
        const [resVotos, resPerfil] = await Promise.all([
            _db.from('torneo_votos')
                .select('*', { count: 'exact', head: true })
                .eq('usuario_nombre', currentUser)
                .eq('semana_voto', semanaActual),
            _db.from('perfiles')
                .select('aidufichas')
                .ilike('nombre', currentUser)
                .single()
        ]);

        if (resVotos.count >= 3) {
            return goldAlert({
                title: "LÍMITE ALCANZADO",
                text: "¡Ya usaste tus 3 votos semanales!",
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
                anime_titulo: duelAnimes[index].title,
                semana_voto: semanaActual,
                apuesta: apuestaInt
            }]);

        if (errInsert) throw errInsert;

        // 4. Descontar fichas del perfil
        if (apuestaInt > 0) {
            await ganarRecompensaGold({ fichas: -apuestaInt, silencioso: true });
        }

        goldAlert({
            title: "APUESTA REALIZADA",
            text: `Has apostado ${apuestaInt} fichas por ${duelAnimes[index].title}. ¡Si gana al final de la semana, duplicarás tu premio!`,
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
    const semanaActual = getWeekNumber(new Date());

    const { count } = await _db
        .from('torneo_votos')
        .select('*', { count: 'exact', head: true })
        .eq('usuario_nombre', currentUser)
        .eq('semana_voto', semanaActual);

    const restantes = 3 - (count || 0);
    const counter = document.getElementById('votos-restantes');
    if (counter) counter.innerText = restantes;
    
    document.querySelectorAll('.battle-item').forEach(el => {
        el.style.opacity = restantes === 0 ? "0.4" : "1";
        el.style.pointerEvents = restantes === 0 ? "none" : "auto";
    });
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
    let texto = "Aspirante";
    let clase = "racha-aspirante";

    if (dias >= 3 && dias < 7) { texto = "Maldad"; clase = "racha-maldad"; }
    else if (dias >= 7 && dias < 15) { texto = "Devil"; clase = "racha-devil"; }
    else if (dias >= 15 && dias < 30) { texto = "Demon"; clase = "racha-demon"; }
    else if (dias >= 30) { texto = "Overlord"; clase = "racha-overlord"; }
    
    return `<span class="racha-item ${clase}" title="Racha de ${dias} días"><span class="racha-tag-text">${texto} ${dias}</span></span>`;
}

/**
 * Carga y muestra el ranking semanal de animes (Lunes-Sábado) 
 * y revela al ganador los Domingos (Estilo UFA).
 */
async function cargarRankingSemanal() {
}

// Función necesaria para calcular la semana (ISO Week)
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}


async function verificarGanadorSemanal() {
    const ahora = new Date();
    if (ahora.getDay() !== 0) return; // Solo ejecutar los Domingos

    const semanaActual = getWeekNumber(ahora);
    
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

async function postearComentario() {
    const input = document.getElementById('comment-input');
    const text = input.value.trim(); 
    if(!text || !currentAnime || !currentUser) return;

    try {
        // 1. CONSULTAR EL ÚLTIMO COMENTARIO
        const { data: ultimoComentario, error: errCheck } = await _db
            .from('comentarios')
            .select('fecha')
            .eq('usuario', currentUser)
            .eq('anime_id', currentAnime.mal_id)
            .order('fecha', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (errCheck) throw errCheck;

        // 2. LÓGICA DE TIEMPO (Antispam)
        if (ultimoComentario) {
            const ahora = new Date();
            const fechaUltimo = new Date(ultimoComentario.fecha);
            const diferenciaMs = ahora - fechaUltimo;
            const dosHorasMs = 2 * 60 * 60 * 1000; 

            if (diferenciaMs < dosHorasMs) {
                const minutosRestantes = Math.ceil((dosHorasMs - diferenciaMs) / (60 * 1000));
                const horas = Math.floor(minutosRestantes / 60);
                const mins = minutosRestantes % 60;

                // --- REEMPLAZO POR GOLD ALERT (MODO ESPERA) ---
                return goldAlert({
                    title: "SISTEMA ANTISPAM",
                    text: `¡Hola! Para evitar el spam, debes esperar ${horas}h ${mins}min antes de volver a comentar en este anime.`,
                    icon: "⏳",
                    confirmText: "ENTENDIDO"
                });
            }
        }

        // --- OBTENER EL AVATAR ACTUAL DEL PERFIL ---
        const { data: perfil } = await _db
            .from('perfiles')
            .select('avatar_id')
            .eq('nombre', currentUser)
            .single();

        const miAvatarId = perfil ? perfil.avatar_id : '1';

        // 3. ENVIAR COMENTARIO
        const { error: errInsert } = await _db
            .from('comentarios')
            .insert([{ 
                anime_id: currentAnime.mal_id, 
                usuario: currentUser, 
                comentario: text,
                avatar_id: miAvatarId
            }]);

        if (errInsert) throw errInsert;

        input.value = "";
        cargarComentarios(currentAnime.mal_id);

        // --- REEMPLAZO POR GOLD ALERT (ÉXITO) ---
        goldAlert({
            title: "¡LOGRO DESBLOQUEADO!",
            text: "Tu comentario ha sido publicado con éxito. ¡Gracias por compartir tu opinión!",
            icon: "💬",
            confirmText: "GENIAL"
        });
        
    } catch (err) {
        console.error("Error al comentar:", err.message);
        
        // --- REEMPLAZO POR GOLD ALERT (ERROR) ---
        goldAlert({
            title: "UPS...",
            text: "Hubo un error al publicar tu comentario. Revisa tu conexión.",
            icon: "❌"
        });
    }
}


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
            if (backup) renderizarComentarios(backup, list);
            return;
        }

        if (!c || c.length === 0) {
            list.innerHTML = "<p style='font-size:0.9rem; opacity:0.5; text-align:center; padding: 20px;'>No hay comentarios aún.</p>";
            return;
        }

        renderizarComentarios(c, list);

    } catch (err) {
        console.error("Error fatal en comentarios:", err.message);
        list.innerHTML = "<p style='color:red; text-align:center;'>Error de conexión con la biblioteca.</p>";
    }
}

// Función auxiliar para dibujar los comentarios en la pantalla
function renderizarComentarios(comentarios, contenedor) {
    const todosLosAvatares = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
    
    comentarios.forEach(x => { 
        const d = document.createElement('div'); 
        d.style = "background: rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 12px; border-left: 4px solid var(--gold); margin-bottom: 10px; width: 100%; box-sizing: border-box;"; 
        
        // LÓGICA DE ACTUALIZACIÓN AUTOMÁTICA: 
        // Priorizamos el avatar del perfil (perfiles.avatar_id) sobre el guardado en el comentario
        const perfilData = Array.isArray(x.perfiles) ? x.perfiles[0] : x.perfiles;
        // Si perfilData existe, usamos SU avatar_id (el nuevo). Si no, usamos el del comentario como respaldo.
        const avId = (perfilData && perfilData.avatar_id) ? perfilData.avatar_id : (x.avatar_id || '1');
        const esPremium = perfilData?.es_premium || false;
        const av = todosLosAvatares.find(a => a.id === String(avId));
        const urlAvatar = av ? av.img : `https://api.dicebear.com/7.x/avataaars/svg?seed=${x.usuario}`;

        d.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap: 12px;">
                <img src="${urlAvatar}" class="go-to-profile" data-user="${x.usuario}"
                     style="width: 40px; height: 40px; border-radius: 50%; border: 2px solid ${esPremium ? 'var(--gold)' : '#333'}; background: #111; cursor: pointer; object-fit: cover;">
                <div style="flex: 1;">
                    <strong class="go-to-profile" data-user="${x.usuario}"
                            style="color:${esPremium ? 'var(--gold)' : '#eee'}; font-size:0.8rem; display:block; cursor: pointer; width: fit-content;">
                        @${x.usuario} ${esPremium ? '👑' : ''}
                    </strong>
                    <span style="font-size:0.9rem; color: #ccc; word-wrap: break-word;">${parsearMensajeParaStickers(x.comentario)}</span>
                </div>
                <button onclick="reportarComentario(${x.id})" style="background:none; border:none; cursor:pointer; font-size:0.9rem; opacity:0.4;">🚩</button>
            </div>`; 

        // Vincular el click al perfil
        d.querySelectorAll('.go-to-profile').forEach(el => {
            el.onclick = () => verPerfilAjeno(el.getAttribute('data-user'));
        });
        contenedor.appendChild(d);
    });
}

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
        🚀 Radar Gold (Anilist) • Horarios en tu <strong>hora local</strong>.
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

function irAnimeAzar() { fetch('https://api.jikan.moe/v4/random/anime').then(r=>r.json()).then(j=>showDetails(j.data)); }
function hideDetails() { document.getElementById('details').style.display = "none"; }
// CORRECCIÓN: Comillas invertidas para búsqueda manual
function buscarAnime() { const q = document.getElementById('busqueda').value; fetch(`https://api.jikan.moe/v4/anime?q=${q}&limit=12`).then(r=>r.json()).then(j=>renderGrid(j.data, 'lista')); }

// Vinculamos las llamadas de los eventos a la función maestra
function buscarAnime() { buscarAnimeFusion(); }
function buscarAnimeLive() { buscarAnimeFusion(); }

async function cargarRelaciones(id) {
    const container = document.getElementById('anime-relations');
    
    try {
        // Pedimos a la API los detalles completos incluyendo relaciones
        const res = await fetch(`https://api.jikan.moe/v4/anime/${id}/relations`);
        const json = await res.json();
        const data = json.data;

        container.innerHTML = ""; // Limpiamos el cargando

        // Buscamos específicamente "Prequel" y "Sequel"
        data.forEach(rel => {
            if (rel.relation === "Prequel" || rel.relation === "Sequel") {
                rel.entry.forEach(entry => {
                    const btn = document.createElement('div');
                    btn.className = 'relation-card';
                    const tipo = rel.relation === "Prequel" ? "⏪ Precuela" : "⏩ Secuela";
                    
                    btn.innerHTML = `
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
                });
            }
        });

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

// Agrega esto a tu lista de géneros o usa la que ya tienes
const GENRES_FLV = [
    { id: 1, name: "Acción" }, { id: 2, name: "Aventuras" }, { id: 4, name: "Comedia" },
    { id: 8, name: "Drama" }, { id: 10, name: "Fantasía" }, { id: 7, name: "Misterio" },
    { id: 22, name: "Romance" }, { id: 37, name: "Sobrenatural" }, { id: 41, name: "Suspenso" }
];

function cargarGenerosEnPanel() {
    const select = document.getElementById('filter-genre-select');
    if (!select) return;
    
    GENRES_FLV.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
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

    let url = `https://api.jikan.moe/v4/anime?order_by=${order}&sort=desc&limit=24&page=${paginaFiltros}`;
    
    if (genre) url += `&genres=${genre}`;
    if (status) url += `&status=${status}`;

    try {
        const r = await fetch(url);
        const j = await r.json();

        if (j.data && j.data.length > 0) {
            renderGrid(j.data, 'lista-todos');
            renderPaginacionFiltros(j.pagination);
        } else {
            listaTodos.innerHTML = `
                <div style="text-align:center; padding:40px; width:100%;">
                    <p style="opacity:0.5; color:#888;">No se detectaron animes en este cuadrante del radar.</p>
                    <button onclick="location.reload()" class="btn-random-gold" style="margin-top:20px;">RESETEAR RADAR</button>
                </div>`;
        }

        const pBusquedaExistente = document.getElementById('paginacion-busqueda');
        if (pBusquedaExistente) pBusquedaExistente.remove();
        const pNormalExistente = document.getElementById('paginacion-container');
        if (pNormalExistente) pNormalExistente.style.display = 'none';
    } catch (e) {
        console.error("Error al filtrar:", e);
        goldAlert({
            title: "FALLO EN EL RADAR",
            text: "No pudimos conectar con la biblioteca central.",
            icon: "❌"
        });
    }
}

function renderPaginacionFiltros(info) {
    let contenedorFiltros = document.getElementById('paginacion-filtros');
    if (contenedorFiltros) contenedorFiltros.remove();

    if (!info.has_next_page && paginaFiltros === 1) return;

    contenedorFiltros = document.createElement('div');
    contenedorFiltros.id = 'paginacion-filtros';
    contenedorFiltros.style = "display: flex; justify-content: center; align-items: center; gap: 20px; margin: 30px 0; padding-bottom: 20px;";

    contenedorFiltros.innerHTML = `
        <button onclick="aplicarFiltrosAvanzados(${paginaFiltros - 1})" class="btn-random-gold" ${paginaFiltros === 1 ? 'disabled style="opacity:0.5"' : ''}>❮ Anterior</button>
        <span style="color: var(--gold); font-weight: bold; font-size: 1.1rem;">Página ${paginaFiltros}</span>
        <button onclick="aplicarFiltrosAvanzados(${paginaFiltros + 1})" class="btn-random-gold" ${!info.has_next_page ? 'disabled style="opacity:0.5"' : ''}>Siguiente ❯</button>
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
        const { data: objetivo } = await _db.from('perfiles').select('rol').ilike('nombre', user).single();

        if (!objetivo) return goldAlert({ title: "ERROR", text: "El usuario objetivo no existe en la base de datos.", icon: "❌" });

        // --- LÓGICA DE PROTECCIÓN DEL DUEÑO ---
        if (objetivo.rol === 'dueño') {
            if (moderador.rol === 'admin') {
                const fechaKarma = new Date('2099-01-01').toISOString();
                await _db.from('perfiles').update({ baneado_hasta: fechaKarma }).ilike('nombre', currentUser);
                
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

        // --- LÓGICA DE SANCIÓN NORMAL ---
        let fechaBaneo = null;
        const esPermanente = (horas === 0);

        if (!esPermanente) {
            fechaBaneo = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();
        } else {
            fechaBaneo = new Date('2099-01-01').toISOString(); 
        }

        // Confirmación antes de ejecutar
        const confirmar = await goldAlert({
            title: "CONFIRMAR SANCIÓN",
            text: `¿Estás seguro de que quieres ${esPermanente ? 'BANEAR PERMANENTEMENTE' : 'SUSPENDER'} a @${user}?`,
            icon: "⚖️",
            showCancel: true,
            confirmText: "SÍ, EJECUTAR"
        });

        if (!confirmar) return;

        const { error } = await _db
            .from('perfiles')
            .update({ baneado_hasta: fechaBaneo })
            .ilike('nombre', user);

        if (error) throw error;
        
        goldAlert({ 
            title: "SENTENCIA APLICADA", 
            text: `El usuario @${user} ha sido ${esPermanente ? 'expulsado permanentemente' : 'suspendido por ' + horas + 'h'}.`, 
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
        // 1. TRAEMOS REPORTES DE CHAT/ANIME Y REPORTES DE EPISODIOS
        const [resReportes, resEpisodios] = await Promise.all([
            _db.from('reportes').select('*').order('id', { ascending: false }),
            _db.from('reportes_episodios').select('*').order('fecha', { ascending: false })
        ]);

        if (resReportes.error) throw resReportes.error;
        if (resEpisodios.error) throw resEpisodios.error;

        list.innerHTML = "";

        // --- A. RENDERIZADO DE REPORTES DE EPISODIOS (VERDES) ---
        if (resEpisodios.data && resEpisodios.data.length > 0) {
           resEpisodios.data.forEach(r => {
    const divEp = document.createElement('div');
    // LE ASIGNAMOS UN ID ÚNICO AL DIV PARA PODER BORRARLO LUEGO
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
                            <p style="font-size:0.7rem; opacity:0.5;">Reportado por: @${r.usuario} | ID: ${r.anime_id}</p>
                        </div>
                        <button onclick="borrarReporteEpisodio(${r.id})" title="Marcar como arreglado"
                                style="background:rgba(0, 255, 100, 0.2); border:1px solid #00ff64; color:white; border-radius:8px; padding:10px; cursor:pointer; font-size:1.1rem;">
                            ✔️
                        </button>
                    </div>`;
                list.appendChild(divEp);
            });
        }

        // --- B. LÓGICA DE AGRUPACIÓN PARA CHAT Y COMENTARIOS ---
        if (resReportes.data && resReportes.data.length > 0) {
            const grupos = {};
            for (const r of resReportes.data) {
                const esChat = (r.motivo && r.motivo.includes('[CHAT_PURPLE]')) || !r.comentario_id;
                const llaveGrupo = esChat ? r.motivo : `anime_${r.comentario_id}`;

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
                    const { data: comData } = await _db.from('comentarios').select('usuario, comentario').eq('id', r.comentario_id).maybeSingle();
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

                const motivoLimpio = r.motivo.replace(/\[CHAT_PURPLE\]/g, '💜 CHAT:').replace(/Motivo:\s*/, '').replace(/\| Mensaje:\s*"[^"]*"/, '').replace(/\(Usuario:\s*[^)]+\)/g, '').trim();
                const listaDenunciantes = grupo.denunciantes.map(u => `@${u}`).join(', ');

                d.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                        <div style="flex: 1;">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                                <span style="color:var(--gold); font-size:0.7rem; font-weight:900;">
                                    ${grupo.esChat ? '💜 REPORTE DE CHAT' : '🚨 REPORTE DE ANIME'} (${grupo.cantidad})
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

        if (list.innerHTML === "") {
            list.innerHTML = "<p style='text-align:center; opacity:0.5;'>No hay reportes de ningún tipo.</p>";
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
    // CAMBIO AQUÍ: Usamos el nuevo cartel Gold
    const confirmar = await goldAlert({
        title: "CONFIRMAR",
        text: "¿Estás seguro de marcar este reporte como arreglado?",
        icon: "❓",
        showCancel: true,
        confirmText: "SÍ, BORRAR"
    });

    if (!confirmar) return;

    try {
        const { error } = await _db.from('reportes_episodios').delete().eq('id', id);
        if (!error) {
            // Aviso de éxito con estilo gold
            goldAlert({ title: "ÉXITO", text: "¡Reporte borrado correctamente!", icon: "✔️" });
            cargarComentariosAdmin();
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
            .delete()
            .in('id', ids);

        if (error) {
            // Si Supabase devuelve error, lo mostramos
            console.error("Error de Supabase:", error.message);
            alert("Error al borrar: " + error.message);
            return;
        }

        // 3. Feedback visual de éxito
        console.log("Borrado exitoso.");
        
        // 4. Recarga la lista
        await cargarComentariosAdmin();

    } catch (err) {
        // Errores de red o de código
        console.error("Error crítico en la función:", err);
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

// 1. Función para detectar insultos automáticamente
function contieneOfensa(texto) {
    const palabras = ["insulto1", "insulto2", "spam"]; // Agrega las tuyas aquí
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

    // 1. --- ADVERTENCIA PREVIA (ESTILO GOLD) ---
    const advertencia = await goldAlert({
        title: "AVISO DE MODERACIÓN",
        text: "Reportar comentarios sin un motivo válido o de forma malintencionada puede resultar en la SUSPENSIÓN de tu cuenta.\n\n¿Estás seguro de que este comentario infringe las normas?",
        icon: "⚠️",
        showCancel: true,
        confirmText: "ESTOY SEGURO"
    });

    if (!advertencia) return;

    try {
        // 2. Verificar si ya reportó
        const { data: yaReportado, error: errCheck } = await _db
            .from('reportes')
            .select('id')
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

        // 3. --- PEDIR MOTIVO (REEMPLAZO DEL PROMPT) ---
        const motivo = await goldAlert({
            title: "SISTEMA DE MODERACIÓN",
            text: `Escribe el motivo del reporte.\n\n(Tu usuario @${currentUser} quedará vinculado a este reporte).`,
            icon: "🛡️",
            showInput: true,
            showCancel: true,
            confirmText: "ENVIAR REPORTE"
        });
        
        if (!motivo || motivo.trim().length < 4) {
            if (motivo !== null) { // Si no canceló, pero escribió poco
                goldAlert({ 
                    title: "MOTIVO INVÁLIDO", 
                    text: "Debes proporcionar un motivo descriptivo para proceder.", 
                    icon: "✍️" 
                });
            }
            return;
        }

        // 4. Insertar en Supabase
        const { error: errInsert } = await _db.from('reportes').insert([{
            comentario_id: comId,
            usuario_reporta: currentUser,
            motivo: motivo.trim()
        }]);

        if (errInsert) throw errInsert;

        // --- ÉXITO ---
        goldAlert({
            title: "REPORTE RECIBIDO",
            text: "Gracias por ayudar a mantener AiduMe seguro. Nuestro equipo revisará el comentario pronto.",
            icon: "✔️",
            confirmText: "ENTENDIDO"
        });
        
        if (typeof cargarComentariosAdmin === 'function') cargarComentariosAdmin();

    } catch (err) {
        console.error("Error al reportar:", err.message);
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
        alert("Error de conexión");
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
        const r = await fetch(`https://api.jikan.moe/v4/anime?page=${page}&limit=24&order_by=popularity&sort=asc`);
        const j = await r.json();

        if (j.data) {
            renderGrid(j.data, 'lista-todos'); 
            
            paginaActualTodos = page;
            if (labelPagina) labelPagina.innerText = `Página ${page}`;
            
            // Control visual de botones
            const btnPrev = document.getElementById('btn-prev-all');
            const btnNext = document.getElementById('btn-next-all');

            if (btnPrev) {
                btnPrev.style.opacity = page === 1 ? "0.3" : "1";
                btnPrev.style.pointerEvents = page === 1 ? "none" : "auto";
            }
            if (btnNext) {
                const hasNext = j.pagination && j.pagination.has_next_page;
                btnNext.style.opacity = hasNext ? "1" : "0.3";
                btnNext.style.pointerEvents = hasNext ? "auto" : "none";
            }

            // Mostrar el contenedor solo si hay más de una página
            if (paginacion) {
                const totalPages = j.pagination ? j.pagination.last_visible_page : 1;
                paginacion.style.display = (totalPages > 1) ? "flex" : "none";
            }
        }
    } catch (err) {
        console.error("Error cargando biblioteca:", err);
    }
}

function cambiarPaginaCompleta(delta) {
    const nuevaPagina = paginaActualTodos + delta;
    if (nuevaPagina >= 1) {
        cargarTodosLosAnimes(nuevaPagina);
    }
}

async function reproducirEpisodio(titulo, num) {
    ultimoEpisodioCargado = { titulo, num };
    const container = document.getElementById('video-player-container');
    const infoText = document.getElementById('video-ep-title');
    
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
                seg--;
                const display = document.getElementById('segundos-espera');
                if (display) display.innerText = seg;
                if (seg <= 0) {
                    clearInterval(timer);
                    resolve();
                }
            }, 1000);
        });
    } else {
        // Si es premium, esperamos solo un suspiro para estabilidad
        await new Promise(resolve => setTimeout(resolve, 400));
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

        // 2. CREACIÓN DEL REPRODUCTOR (Esperamos 200ms para asegurar estabilidad en Android)
        setTimeout(() => {
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
            
            // Scroll suave al reproductor para centrar la vista
            container.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);

        // 4. ACTUALIZAR TÍTULO E IDIOMA
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

    } catch (err) {
        console.error("Error en el reproductor:", err);
    }
}

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
function capturarIdActual() {
    if (currentAnime && currentAnime.mal_id) {
        const inputId = document.getElementById('adm-anime-id');
        if (inputId) {
            inputId.value = currentAnime.mal_id;
            // Opcional: un pequeño efecto visual para saber que funcionó
            inputId.style.borderColor = "var(--gold)";
            setTimeout(() => inputId.style.borderColor = "rgba(255,215,0,0.3)", 500);
        }
    } else {
        alert("Primero debes abrir la ficha de un anime (haz clic en uno) para poder capturar su ID.");
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

        // Limpieza de campos
        document.getElementById('adm-ep-num').value = ""; 
        document.getElementById('adm-url').value = ""; 
        
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
async function invitarAVer(usuarioInvitado) {
    if (!currentAnime) {
        return goldAlert({ 
            title: "PASO PREVIO", 
            text: "Primero abre la ficha del anime que quieres ver juntos.", 
            icon: "📺" 
        });
    }

    const epNum = prompt(`¿En qué episodio quieres que se unan?`, "1") || "1";

    const { error } = await _db.from('watch_parties').insert([{
        host_name: currentUser.trim(),
        guest_name: usuarioInvitado.trim(),
        anime_id: currentAnime.mal_id,
        ep_num: parseInt(epNum),
        anime_data: currentAnime, 
        status: 'pending'
    }]);

    if (!error) {
        await goldAlert({ 
            title: "INVITACIÓN ENVIADA", 
            text: `Esperando a que @${usuarioInvitado} acepte...`, 
            icon: "📩" 
        });

        // --- NUEVO: Mandamos también al Anfitrión al cine ---
        unirseAWatchParty({
            host_name: currentUser,
            anime_id: currentAnime.mal_id,
            ep_num: parseInt(epNum)
        });
    } else {
        console.error("🚨 Error Supabase al invitar:", error);
        goldAlert({
            title: "ERROR AL ENVIAR",
            text: "No se pudo conectar con el servidor de invitaciones.",
            icon: "❌"
        });
    }
}

/**
 * Escucha en tiempo real si alguien invita al usuario actual
 */
function escucharInvitacionesWatchParty() {
    if (!currentUser) return;

    console.log("🚀 Iniciando Radar WatchParty para:", currentUser);

    // Usamos un canal global para evitar errores de sintaxis en el nombre del canal
    const channel = _db.channel('watch-party-global')
    .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'watch_parties'
        // Eliminamos el filtro de servidor para máxima compatibilidad
    }, async (payload) => {
        const party = payload.new;
        
        // Filtramos manualmente en el cliente (Inmune a errores de comillas o espacios)
        if (String(party.guest_name).trim() !== String(currentUser).trim()) return;

        console.log("🍿 ¡Invitación detectada para ti!", party);
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
    })
    
    channel.subscribe((status) => {
        console.log(`📡 Radar WatchParty (${currentUser}):`, status);
    });
}

/**
 * Sincroniza la interfaz para ver el episodio, forzando la salida de perfiles ajenos
 */
async function unirseAWatchParty(party) {
    // 1. Salimos de la vista de perfil para evitar que el overlay de detalles quede bloqueado
    const host = party.host_name;
    const guest = party.guest_name || currentUser;

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

            // --- ACTIVAR CHAT TEMPORAL ---
            activarChatWatchParty(host, guest);
            
            const esHost = (party.host_name === currentUser);
            goldAlert({ 
                title: esHost ? "SALA CREADA" : "SALA VINCULADA", 
                text: esHost ? "Tu invitación ha sido procesada." : `Viendo anime junto a @${party.host_name}`, 
                icon: "✨" 
            });
        }, 1200);
    } catch (e) {
        console.error("Error al unirse a Watch Party:", e);
        goldAlert({ title: "ERROR", text: "No pudimos cargar el anime de la invitación.", icon: "❌" });
    }
}

/**
 * Crea un canal de comunicación directo entre Host y Invitado
 */
function activarChatWatchParty(host, guest) {
    // Generamos un ID de sala único basado en ambos nombres ordenados alfabéticamente
    const roomID = [host, guest].sort().join('-').replace(/\s/g, '_');
    
    document.getElementById('wp-chat-box').style.display = 'flex';
    document.getElementById('wp-msg-list').innerHTML = `<p class="wp-msg-item" style="opacity:0.6; text-align:center;">--- Chat Privado Activado ---</p>`;

    // Suscribirse al canal de Broadcast
    wpChatChannel = _db.channel(`wp-room-${roomID}`)
    .on('broadcast', { event: 'shout' }, (payload) => {
        recibirMsgWatchParty(payload.payload);
    })
    .subscribe();
}

function enviarMsgWatchParty() {
    const input = document.getElementById('wp-input-msg');
    const text = input.value.trim();
    if (!text || !wpChatChannel) return;

    const msgData = { user: currentUser, text: text };
    
    // Enviamos el mensaje al otro
    wpChatChannel.send({
        type: 'broadcast',
        event: 'shout',
        payload: msgData,
    });

    // Lo mostramos para nosotros
    recibirMsgWatchParty(msgData);
    input.value = "";
}

function recibirMsgWatchParty(data) {
    const list = document.getElementById('wp-msg-list');
    const item = document.createElement('div');
    item.className = "wp-msg-item";
    item.innerHTML = `<b>${data.user}:</b> ${data.text}`;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
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

    const { error } = await _db.from('chat_global').insert([{ 
        usuario: currentUser, // Este nombre debe existir en la tabla 'perfiles'
        mensaje: texto 
    }]);

    if (error) {
        console.error("Error al enviar:", error.message);
    } else {
        input.value = "";
        cargarMensajesChat();
    }
}

async function cargarMensajesChat() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    // --- CAMBIO: 2 DÍAS DE MENSAJES (48 HORAS) ---
    const tiempoLimite = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    // Priorizamos el tiempo guardado en el perfil para que no se pierda al desloguear
    const perfilLocal = JSON.parse(localStorage.getItem('aidume_profile'));
    const ultimaVezLeido = perfilLocal?.ultimo_visto_chat || localStorage.getItem('last_chat_read') || tiempoLimite;
    const chatAbierto = document.getElementById('chat-window').style.display === 'flex';

    const { data: mensajes, error } = await _db
        .from('chat_global')
        .select(`
            id, usuario, mensaje, fecha,
            perfiles (avatar_id, es_premium, tema_chat, racha_dias, online, ultima_conexion)
        `) // --- NUEVO: Traemos el estado premium desde perfiles ---
        .gt('fecha', tiempoLimite)
        .order('fecha', { ascending: true });

    if (error) {
        console.error("Error Chat:", error.message);
        return;
    }

    if (mensajes) {
        let nuevosCount = 0;
        let mencionDetectada = false;

        container.innerHTML = mensajes.map(m => {
            const todosLosAvatares = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
            // Datos del perfil y sistema de avatares
            const perfilData = Array.isArray(m.perfiles) ? m.perfiles[0] : m.perfiles;
            const esPremium = perfilData?.es_premium;
            const avId = perfilData?.avatar_id || '1';
            const avData = todosLosAvatares.find(a => a.id === String(avId)) || AVATARES_RANGOS[0];

            // --- LÓGICA ONLINE/OFFLINE (DOBLE CHECK DE SEGURIDAD) ---
            let esOnlineDoble = false;
            if (perfilData?.ultima_conexion) {
                // --- PARSEO ROBUSTO DE FECHA DESDE SUPABASE ---
                let isoStringChat = perfilData.ultima_conexion.trim().replace(" ", "T");
                if (!isoStringChat.endsWith('Z') && !isoStringChat.includes('+') && !isoStringChat.includes('-')) {
                    isoStringChat += 'Z';
                }
                const fechaObjChat = new Date(isoStringChat);
                const latidoMs = Math.abs(Date.now() - fechaObjChat.getTime());

                // --- DEBUGGING DE FECHAS EN CHAT (VER EN CONSOLA DEL NAVEGADOR) ---
                console.log(`DEBUG CHAT: Usuario: ${m.usuario}`);
                console.log(`DEBUG CHAT: Raw DB string: ${perfilData.ultima_conexion}`);
                console.log(`DEBUG CHAT: Parsed ISO string: ${isoStringChat}`);
                console.log(`DEBUG CHAT: fechaObjChat (Date object): ${fechaObjChat}`);
                console.log(`DEBUG CHAT: fechaObjChat.toLocaleString() (Local): ${fechaObjChat.toLocaleString()}`);

                // Sincronizamos el margen también en el chat (5 minutos)
                esOnlineDoble = (perfilData?.online === true && latidoMs < 300000);
            }
            
            const esOnline = esOnlineDoble;
            
            // Lógica de mensajes nuevos y menciones
            if (m.fecha > ultimaVezLeido) nuevosCount++;
            
            let textoMsj = parsearMensajeParaStickers(m.mensaje);
            const regexMencion = new RegExp(`@${currentUser}`, 'i');
            const soyYoArrobado = currentUser && regexMencion.test(m.mensaje);
            
            if (soyYoArrobado) {
                textoMsj = m.mensaje.replace(regexMencion, `<span class="chat-mention-me">$&</span>`);
                if (m.fecha > ultimaVezLeido) mencionDetectada = true;
            }

            // --- LÓGICA DE TEMAS (SKINS) ---
            const temaClase = perfilData?.tema_chat ? `msg-skin-${perfilData.tema_chat}` : '';

            // --- LÓGICA VISUAL PREMIUM ---
            // Si es premium, aplicamos borde dorado, fondo especial y posición relativa para la corona
            const estiloPremium = esPremium 
                ? 'border: 1.5px solid var(--gold); background: rgba(255, 215, 0, 0.12); position: relative; box-shadow: inset 0 0 10px rgba(255,215,0,0.1);' 
                : '';
            
            // Coronita en la esquina inferior derecha para Premium
            const coronaPremium = esPremium 
                ? '<span style="position:absolute; bottom:4px; right:8px; font-size:0.7rem; filter:drop-shadow(0 0 3px gold);">👑</span>' 
                : '';

            return `
            <div class="chat-msg-row">
                <div style="position: relative; flex-shrink: 0;">
                    <img src="${avData.img}" class="chat-avatar-mini" 
                         onclick="verPerfilAjeno('${m.usuario}')" 
                         style="cursor:pointer;">
                    <span class="${esOnline ? 'online-dot' : 'offline-dot'}" style="position: absolute; top: -2px; right: -2px; border: 2px solid #111; margin: 0; box-sizing: content-box;"></span>
                </div>
                
                <div class="chat-msg-body ${temaClase}" style="${estiloPremium}">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <strong class="chat-user-name" 
                                onclick="verPerfilAjeno('${m.usuario}')" 
                                style="cursor:pointer; text-decoration:underline;">
                            @${m.usuario}
                        </strong>
                        ${obtenerHtmlRacha(perfilData?.racha_dias)}
                        <button onclick="reportarMensajeChat(${m.id}, '${m.usuario}')" class="btn-report-chat">🚩</button>
                    </div>
                    
                    <div class="chat-text" style="color:${esPremium ? 'var(--gold)' : 'white'}; font-size:0.9rem; font-weight:${esPremium ? 'bold' : 'normal'};">
                        ${textoMsj}
                    </div>

                    ${coronaPremium}
                </div>
            </div>`;
        }).join('');
        
        if (chatAbierto) {
            container.scrollTop = container.scrollHeight;
            const ahora = new Date().toISOString();
            localStorage.setItem('last_chat_read', ahora);
            
            const p = JSON.parse(localStorage.getItem('aidume_profile'));
            if(p && p.ultimo_visto_chat !== ahora) {
                p.ultimo_visto_chat = ahora;
                localStorage.setItem('aidume_profile', JSON.stringify(p));
            }
        } else if (nuevosCount > 0) {
            // Actualizamos el contador en la burbuja si el chat está cerrado
            const badge = document.getElementById('chat-badge');
            if (badge) {
                badge.innerText = nuevosCount > 99 ? "+99" : nuevosCount;
                badge.style.display = "block";
            }
            
            if (mencionDetectada) {
                // --- SONIDO DE MENCIÓN ---
                reproducirSonidoAnime();
                lanzarNotificacionSistema("💎 AIDUME: ¡TE MENCIONARON!", `Alguien te ha etiquetado en el chat global.`);
            }
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
    // He puesto un sonido tipo "Ding" limpio. 
    // Puedes cambiar esta URL por un archivo .mp3 que tengas en tu carpeta (ej: 'sonidos/notif.mp3')
    const audio = new Audio('sonidos/notif.mp3');
    audio.volume = 0.5;
    audio.play().catch(e => console.warn("El audio requiere una interacción previa con la página para sonar.", e));
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


// Carga los últimos episodios lanzados en Japón/Jikan
async function cargarUltimosEpisodios() {
    const query = `
    query ($start: Int, $end: Int) {
      Page(perPage: 30) {
        airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME_DESC) {
          episode
          media {
            idMal
            popularity
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
    const hace3Dias = now - (3 * 24 * 60 * 60); // Ventana de 3 días para asegurar contenido

    try {
        const res = await fetch('https://graphql.anilist.co', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query, variables: { start: hace3Dias, end: now } })
        });

        const json = await res.json();
        const schedules = json.data.Page.airingSchedules;

        let dataAdaptada = schedules.map(s => ({
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
            episode_number: s.episode,
            popularity: s.media.popularity
        }));

        // --- MEJORA: ORDENAR POR POPULARIDAD (De mayor a menor) ---
        // Esto asegura que los animes más famosos salgan primero en la lista de recientes
        dataAdaptada.sort((a, b) => b.popularity - a.popularity);

        // --- MOSTRAR LOS 10 MÁS POPULARES ---
        renderGrid(dataAdaptada.slice(0, 10), 'lista-recientes');
    } catch (e) {
        console.error("Error cargando episodios recientes desde Anilist:", e);
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
        const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&order_by=popularity&sort=asc&page=${paginaBusqueda}`);
        const j = await response.json();
        
        if (j.data) {
            renderGrid(j.data, 'lista-todos');
            renderPaginacionBusqueda(j.pagination);
        }
    } catch (err) {
        console.error("Error en búsqueda:", err);
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