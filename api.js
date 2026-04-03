let currentAnime = null;
let duelAnimes = [];
let paginaActualTodos = 1;
let idiomaActual = 'sub';
let ultimoEpisodioCargado = null;

// Lista de palabras que activarán la alerta roja
const PALABRAS_PROHIBIDAS = ["insulto1", "insulto2", "spam", "ofensa"];

async function initApp() {
    await cargarDuelo();
    cargarHome();
    cargarTodosLosAnimes(1); // Carga inicial de la lista completa
    cargarGenerosEnPanel();
}

async function cargarHome() {
    const r = await fetch('https://api.jikan.moe/v4/top/anime?limit=12');
    const j = await r.json();
    renderGrid(j.data, 'lista');
}

async function showDetails(a) {
    // --- 0. RESET Y LIMPIEZA DEL REPRODUCTOR ---
    // Usamos querySelector para asegurar compatibilidad con la clase .video-iframe-aidume
    const iframePrev = document.querySelector('.video-iframe-aidume') || document.getElementById('video-iframe');
    const videoContainer = document.getElementById('video-player-container');
    const videoInfo = document.getElementById('video-ep-title');

    if (iframePrev) iframePrev.src = ""; // Detiene cualquier video anterior
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

    // --- NUEVO: MOSTRAR ID SOLO A DUEÑO/ADMIN ---
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

    // --- 2. GENERADOR DE EPISODIOS CON VIDEO ---
    const gridEps = document.getElementById('grid-episodios');
    const epBadge = document.getElementById('ep-count-badge');
    
    let totalEps = parseInt(a.episodes) || 0;
    let estaEnEmision = a.status === "Currently Airing";

    if (gridEps) {
        gridEps.innerHTML = "<p style='text-align:center; opacity:0.5; padding:20px;'>Cargando progreso...</p>"; 

        let listaVistos = [];
        if (currentUser) {
            try {
                const { data: vistos } = await _db
                    .from('episodios_vistos')
                    .select('episodio_num')
                    .eq('usuario_nombre', currentUser)
                    .eq('anime_id', a.mal_id);
                if (vistos) listaVistos = vistos.map(v => v.episodio_num);
            } catch (err) { console.error("Error cargando progreso:", err); }
        }

        const dibujarBotones = (cantidad) => {
            let html = "";
            for (let i = 1; i <= cantidad; i++) {
                const isChecked = listaVistos.includes(i) ? 'checked' : '';
                
                // MEJORA: Se limpia el nombre de comillas para que el onclick no falle
                // Se asegura que llame a reproducirEpisodio correctamente
                html += `
                    <div class="episode-row">
                        <div class="ep-info" onclick="reproducirEpisodio('${nombreFinal.replace(/'/g, "\\'")}', ${i})">
                            <span class="play-icon">▶</span>
                            <div>
                                <div class="ep-name">${nombreFinal}</div>
                                <div class="ep-num">Episodio ${i}</div>
                            </div>
                        </div>
                        <div class="ep-check-area">
                            <label class="custom-checkbox">
                                <input type="checkbox" ${isChecked} onchange="toggleEpisodioVisto(${a.mal_id}, ${i}, this)">
                                <span class="checkmark"></span>
                            </label>
                            <span class="check-text">VISTO</span>
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
            
            textoTraducido = textoTraducido.replace(/\[Escrito por MAL Rewrite\]/g, "");
            textoTraducido = textoTraducido.replace(/\[Written by MAL Rewrite\]/g, "");
            
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

// FUNCIÓN AUXILIAR PARA EL CHECKBOX (Agrégala también en api.js)
async function toggleEpisodioVisto(animeId, epNum, checkbox) {
    if (!currentUser) return alert("Inicia sesión para guardar tu progreso");
    try {
        if (checkbox.checked) {
            await _db.from('episodios_vistos').insert([{
                usuario_nombre: currentUser,
                anime_id: animeId,
                episodio_num: epNum
            }]);
        } else {
            await _db.from('episodios_vistos').delete()
                .eq('usuario_nombre', currentUser)
                .eq('anime_id', animeId)
                .eq('episodio_num', epNum);
        }
    } catch (err) { console.error("Error guardando progreso:", err); }
}

async function saveHistory(a) {
    if (!currentUser) return;

    try {
        // 1. Guardar el anime en el historial de vistos
        await _db.from('vistos').upsert({
            usuario_nombre: currentUser,
            anime_id: a.mal_id,
            titulo: a.title,
            imagen_url: a.images.jpg.image_url,
            fecha_visto: new Date().toISOString()
        }, { onConflict: 'usuario_nombre, anime_id' });

        // 2. OBTENER PROGRESO ACTUAL DE SUPABASE
        const { data: perfil } = await _db
            .from('perfiles')
            .select('xp, nivel')
            .eq('nombre', currentUser)
            .single();

        let nuevaXP = (perfil.xp || 0) + 1;
        let nuevoNivel = perfil.nivel || 1;

        // 3. SUBIR DE NIVEL (Cada 3 de XP)
        if (nuevaXP >= 3) {
            nuevaXP = 0;
            nuevoNivel++;
        }

        // 4. GUARDAR CAMBIOS EN LA NUBE
        await _db
            .from('perfiles')
            .update({ xp: nuevaXP, nivel: nuevoNivel })
            .eq('nombre', currentUser);

        console.log(`✅ XP: ${nuevaXP}/3 | Nivel: ${nuevoNivel}`);

        // Actualizar la interfaz si el usuario está en la pestaña de perfil
        if (typeof actualizarPerfilDesdeSQL === 'function') {
            actualizarPerfilDesdeSQL();
        }

    } catch (err) {
        console.error("❌ Error al subir XP:", err);
    }
}

// ... (Copia aquí tus funciones de updateListButton, rateAnime, cargarPuntuacionComunidad tal cual las tenías)

// [IMPORTANTE: BORRA LA FUNCIÓN saveHistory QUE ESTABA AL FINAL DE TU ARCHIVO VIEJO]

async function updateListButton() {
    const b = document.getElementById('btn-toggle-list');
    if (!currentAnime || !currentUser) return;

    // Buscamos en la nube si ya es favorito
    const { data: existe } = await _db
        .from('favoritos')
        .select('*')
        .eq('usuario_nombre', currentUser)
        .eq('anime_id', currentAnime.mal_id)
        .maybeSingle();

    if (existe) {
        b.innerHTML = "➖ Quitar de la Lista";
        b.classList.add('in-list'); 
        b.onclick = async () => {
            await _db.from('favoritos').delete()
                .eq('usuario_nombre', currentUser)
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
            .eq('usuario_nombre', currentUser)
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
    // Se eliminó la llamada a actualizarCronometro() que causaba el error
    try {
        const r = await fetch('https://api.jikan.moe/v4/top/anime?limit=25');
        const j = await r.json();
        const hoy = new Date().getDate();
        
        // Rotación diaria basada en el día del mes
        const s = j.data.sort((a, b) => (a.mal_id * hoy) % 10 - (b.mal_id * hoy) % 10);
        duelAnimes = [s[0], s[1]]; 
        
        const img1 = document.getElementById('img1');
        const img2 = document.getElementById('img2');
        const t1 = document.getElementById('t1');
        const t2 = document.getElementById('t2');

        if (img1 && img2) {
            img1.src = duelAnimes[0].images.jpg.image_url;
            img2.src = duelAnimes[1].images.jpg.image_url;
            t1.innerText = duelAnimes[0].title.substring(0,12);
            t2.innerText = duelAnimes[1].title.substring(0,12);
            
            // Actualizar el estado visual del cargando
            const timer = document.getElementById('battle-timer');
            if (timer) timer.innerText = "¡VOTA POR TU FAVORITO!";
        }

        // Cargamos los votos reales de la base de datos
        await actualizarMarcadorGlobal();
        await actualizarVotosUI(); 
    } catch(e) { 
        console.log("Error duelo", e); 
        if (document.getElementById('battle-timer')) {
            document.getElementById('battle-timer').innerText = "Error al cargar";
        }
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
    if (!currentUser) return;
    const semanaActual = getWeekNumber(new Date());

    try {
        // 1. Verificar votos reales en Supabase
        const { count, error: errCheck } = await _db
            .from('torneo_votos')
            .select('*', { count: 'exact', head: true })
            .eq('usuario_nombre', currentUser)
            .eq('semana_voto', semanaActual);

        if (count >= 3) return alert("¡Ya usaste tus 3 votos semanales!");

        // 2. Insertar nuevo voto
        const { error: errInsert } = await _db
            .from('torneo_votos')
            .insert([{
                usuario_nombre: currentUser,
                anime_id: duelAnimes[index].mal_id,
                anime_titulo: duelAnimes[index].title,
                semana_voto: semanaActual
            }]);

        if (errInsert) throw errInsert;

        alert(`¡Votaste por ${duelAnimes[index].title}!`);
        await actualizarMarcadorGlobal();
        await actualizarVotosUI();
        
    } catch (err) {
        console.error("Error al votar:", err.message);
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

// Función necesaria para calcular la semana (ISO Week)
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}


async function verificarGanadorSemanal() {
    const ahora = new Date();
    if (ahora.getDay() !== 6) return; // Solo ejecutar los Sábados

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
        // 1. CONSULTAR EL ÚLTIMO COMENTARIO DEL USUARIO EN ESTE ANIME ESPECÍFICO
        const { data: ultimoComentario, error: errCheck } = await _db
            .from('comentarios')
            .select('fecha')
            .eq('usuario', currentUser)
            .eq('anime_id', currentAnime.mal_id) // <-- ESTA LÍNEA ES LA CLAVE
            .order('fecha', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (errCheck) throw errCheck;

        // 2. LÓGICA DE TIEMPO (2 horas)
        if (ultimoComentario) {
            const ahora = new Date();
            const fechaUltimo = new Date(ultimoComentario.fecha);
            const diferenciaMs = ahora - fechaUltimo;
            const dosHorasMs = 2 * 60 * 60 * 1000; 

            if (diferenciaMs < dosHorasMs) {
                const minutosRestantes = Math.ceil((dosHorasMs - diferenciaMs) / (60 * 1000));
                const horas = Math.floor(minutosRestantes / 60);
                const mins = minutosRestantes % 60;
                
                alert(`⏳ Ya comentaste aquí. Esperá ${horas}h ${mins}min para este anime.`);
                return;
            }
        }

        // 3. ENVIAR COMENTARIO
        const { error: errInsert } = await _db
            .from('comentarios')
            .insert([{ 
                anime_id: currentAnime.mal_id, 
                usuario: currentUser, 
                comentario: text 
            }]);

        if (errInsert) throw errInsert;

        input.value = "";
        cargarComentarios(currentAnime.mal_id);
        alert("✅ ¡Comentario publicado!");
        
    } catch (err) {
        console.error("Error al comentar:", err.message);
    }
}


async function cargarComentarios(id) {
    const list = document.getElementById('lista-comentarios');
    if (!list) return; 
    
    // IMPORTANTE: Esto borra lo que haya quedado de antes para evitar el efecto de "cajas"
    list.innerHTML = ""; 

    try {
        const { data: c, error } = await _db
            .from('comentarios')
            .select('*')
            .eq('anime_id', id)
            .order('fecha', { ascending: false });

        if (error) throw error;

        if (!c || c.length === 0) {
            list.innerHTML = "<p style='font-size:0.9rem; opacity:0.5; text-align:center; padding: 20px;'>No hay comentarios aún.</p>";
            return;
        }

        c.forEach(x => { 
            const d = document.createElement('div'); 
            // Estilo corregido para que no se vea amontonado
            d.style = "background: rgba(255, 255, 255, 0.05); border-radius: 12px; padding: 12px; border-left: 4px solid var(--gold); margin-bottom: 10px; width: 100%; box-sizing: border-box;"; 
            
            d.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div style="width: 90%;">
                        <strong style="color:var(--gold); font-size:0.8rem; display:block;">@${x.usuario}</strong>
                        <span style="font-size:0.9rem; color: #eee; word-wrap: break-word;">${x.comentario}</span>
                    </div>
                    <button onclick="reportarComentario(${x.id})" style="background:none; border:none; cursor:pointer; font-size:0.9rem; opacity:0.4;">🚩</button>
                </div>
            `; 
            list.appendChild(d);
        });

    } catch (err) {
        console.error("Error:", err.message);
    }
}

async function cargarCalendario() {
    const r = await fetch('https://api.jikan.moe/v4/schedules'); 
    const j = await r.json();
    const c = document.getElementById('lista-calendario'); 
    if (!c) return;
    
    c.innerHTML = `
        <div style="background: rgba(255, 215, 0, 0.1); border: 1px dashed var(--gold); padding: 10px; border-radius: 10px; margin-bottom: 20px; font-size: 0.75rem; text-align: center; color: var(--gold);">
            ⚠️ Horarios en <strong>JST (Japón)</strong>. 
            <br>La campana 🔔 programa el aviso en tu <strong>hora local</strong>.
        </div>
    `;

    const diasEsp = {
        'mondays': 'Lunes', 'tuesdays': 'Martes', 'wednesdays': 'Miércoles',
        'thursdays': 'Jueves', 'fridays': 'Viernes', 'saturdays': 'Sábado', 'sundays': 'Domingo'
    };

    const ahora = new Date();
    const horaActual = ahora.getHours();
    const minutoActual = ahora.getMinutes();

    j.data.forEach(a => {
        if (!a.broadcast || !a.broadcast.time) return;

        const diaIngles = a.day ? a.day.toLowerCase() : 'unknown';
        const hoyIngles = ahora.toLocaleDateString('en-US', {weekday: 'long'}).toLowerCase() + 's';
        
        // --- LÓGICA DE CÁLCULO DE FECHA ---
        const diasSemana = ['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays'];
        const indiceObjetivo = diasSemana.indexOf(diaIngles);
        const indiceHoy = ahora.getDay();
        
        // Calculamos cuántos días faltan para ese estreno
        let diferenciaDias = (indiceObjetivo - indiceHoy + 7) % 7;
        
        // Si es el mismo día pero la hora ya pasó, mostramos la fecha de la próxima semana
        const [horaE, minE] = a.broadcast.time.split(':').map(Number);
        if (diferenciaDias === 0 && (horaE < horaActual || (horaE === horaActual && minE < minutoActual))) {
            diferenciaDias = 7;
        }

        // Crear el objeto de fecha para el estreno
        const fechaEstreno = new Date();
        fechaEstreno.setDate(ahora.getDate() + diferenciaDias);
        
        const diaMes = fechaEstreno.getDate().toString().padStart(2, '0');
        const mes = (fechaEstreno.getMonth() + 1).toString().padStart(2, '0');
        const fechaFinal = `${diasEsp[diaIngles]} ${diaMes}/${mes}`;

        // Solo mostramos si no es un estreno que ya pasó hoy (para mantener el calendario limpio)
        if (diferenciaDias >= 0) {
            const d = document.createElement('div'); 
            d.className = "calendario-item";
            d.style = "background:var(--card); margin-bottom:10px; border-radius:15px; display:flex; padding:10px; align-items:center; cursor:pointer;";
            
            d.innerHTML = `
                <img src="${a.images.jpg.image_url}" width="50" style="border-radius:10px; margin-right:12px;">
                <div style="flex:1;">
                    <strong style="font-size:0.9rem;">${a.title}</strong><br>
                    <small style="color:var(--gold); font-weight:bold;">
                        ${fechaFinal} • ${a.broadcast.time} 
                        <span style="font-size:0.6rem; opacity:0.7; background:rgba(255,255,255,0.1); padding:2px 4px; border-radius:4px; margin-left:5px;">JST</span>
                    </small>
                </div>
                <button class="btn-notif" style="background:none; border:1px solid var(--gold); color:var(--gold); border-radius:10px; padding:5px 10px;">🔔</button>
            `;

            const btn = d.querySelector('.btn-notif');
            btn.onclick = (e) => {
                e.stopPropagation();
                agendarNotificacion(a.title, a.images.jpg.image_url, a.broadcast.time, diaIngles);
                btn.innerHTML = '✅';
                btn.style.borderColor = '#4CAF50';
                btn.style.color = '#4CAF50';
            };

            d.onclick = () => showDetails(a); 
            c.appendChild(d);
        }
    });

    if (c.children.length === 1) {
        c.innerHTML += "<p style='text-align:center; opacity:0.5; padding:20px;'>No hay más estrenos confirmados.</p>";
    }
}

function agendarNotificacion(titulo, imagen, horaJST, diaSemanaIngles) {
    if (Notification.permission !== "granted") {
        alert("Debes activar las notificaciones.");
        return;
    }

    // 1. Configurar la hora de estreno en JST (UTC+9)
    const [hora, minutos] = horaJST.split(':').map(Number);
    const ahora = new Date();
    
    // 2. Crear fecha del próximo estreno
    let fechaEstreno = new Date();
    fechaEstreno.setUTCHours(hora - 9, minutos, 0, 0); // Convertimos JST a UTC

    // 3. Ajustar al día de la semana correcto
    const dias = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const objetivo = dias.indexOf(diaSemanaIngles.replace('s', ''));
    let hoy = ahora.getUTCDay();
    
    let diasDiferencia = (objetivo - hoy + 7) % 7;
    fechaEstreno.setUTCDate(ahora.getUTCDate() + diasDiferencia);

    // 4. Si la hora ya pasó hoy, programar para la próxima semana
    if (fechaEstreno < ahora) {
        fechaEstreno.setUTCDate(fechaEstreno.getUTCDate() + 7);
    }

    const tiempoRestante = fechaEstreno.getTime() - ahora.getTime();

    // 5. Programar el aviso
    setTimeout(() => {
        new Notification("¡Estreno en AiduMe!", {
            body: `¡Es hora! Ya salió el nuevo episodio de: ${titulo}`,
            icon: imagen
        });
    }, tiempoRestante);

    // Mostrar al usuario su hora local de estreno
    const horaLocal = fechaEstreno.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    alert(`🔔 Recordatorio fijado: ${titulo} se estrena en tu país a las ${horaLocal}.`);
}

function irAnimeAzar() { fetch('https://api.jikan.moe/v4/random/anime').then(r=>r.json()).then(j=>showDetails(j.data)); }
function hideDetails() { document.getElementById('details').style.display = "none"; }
// CORRECCIÓN: Comillas invertidas para búsqueda manual
function buscarAnime() { const q = document.getElementById('busqueda').value; fetch(`https://api.jikan.moe/v4/anime?q=${q}&limit=12`).then(r=>r.json()).then(j=>renderGrid(j.data, 'lista')); }

/*function actualizarNivelOtaku() {
    const h = JSON.parse(localStorage.getItem('hist_' + currentUser)) || [];
    const totalVistos = h.length;
    
    const nivel = Math.floor(totalVistos / 3) + 1;
    const xpEnNivel = totalVistos % 3;
    const porcentajeXP = (xpEnNivel / 3) * 100;

    let rango = "ASPIRANTE";
    if (nivel >= 2) rango = "GENIN";
    if (nivel >= 3) rango = "CHUNIN";
    if (nivel >= 4) rango = "JOUNIN";
    if (nivel >= 5) rango = "HOKAGE";

    const rankElem = document.getElementById('display-rank');
    const barElem = document.getElementById('xp-bar');
    const txtElem = document.getElementById('xp-text');

    // CORRECCIÓN: Comillas invertidas para los textos del perfil
    if (rankElem) rankElem.innerText = `${rango} (LVL ${nivel})`;
    if (barElem) barElem.style.width = porcentajeXP + "%";
    if (txtElem) txtElem.innerText = `${xpEnNivel}/3 para el siguiente nivel`;
}*/

// Variable global para el temporizador
let tiempoBusqueda;

// FUNCIÓN ÚNICA DE BÚSQUEDA FUSIONADA (CORREGIDA)
async function buscarAnimeFusion(queryManual = null) {
    const busquedaInput = document.getElementById('busqueda');
    const q = queryManual !== null ? queryManual : busquedaInput.value.trim();
    const paginacion = document.getElementById('paginacion-container'); // Referencia al contenedor de páginas
    
    // Si no hay texto, restauramos el Home original
    if (q.length === 0) {
        cargarHome();
        cargarTodosLosAnimes(1); 
        // --- RESTAURACIÓN: Volvemos a mostrar los botones de página ---
        if (paginacion) paginacion.style.display = "flex"; 
        return;
    }

    if (queryManual === null && q.length < 3) return;

    if (tiempoBusqueda) clearTimeout(tiempoBusqueda);

    const listaTodos = document.getElementById('lista-todos');
    if (listaTodos) {
        listaTodos.innerHTML = "<p style='width:100%; text-align:center; color:var(--gold);'>Buscando en la biblioteca...</p>";
    }

    tiempoBusqueda = setTimeout(async () => {
        try {
            const r = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&order_by=popularity&sort=desc`);
            const j = await r.json();
            
            if (j.data) {
                renderGrid(j.data, 'lista-todos');
                
                // --- OCULTAR: Durante una búsqueda no tiene sentido mostrar "Página 1 de la lista general" ---
                if (paginacion) paginacion.style.display = "none";
            }
        } catch (err) {
            console.error("Error en búsqueda:", err);
        }
    }, 500);
}

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
    if (!currentUser) return; // Si no hay usuario, no hace nada

    const confirmar = confirm("¿Estás seguro de que quieres borrar TODO tu historial de vistos? Esta acción no se puede deshacer.");
    
    if (confirmar) {
        try {
            // Ejecutamos el borrado filtrando por el nombre del usuario actual
            const { error } = await _db
                .from('vistos')
                .delete()
                .eq('usuario_nombre', currentUser);

            if (error) throw error;

            alert("Tu historial ha sido limpiado correctamente.");
            
            // Refrescamos la lista en la pantalla para que se vea vacía
            if (typeof cargarListaDesdeSQL === 'function') {
                cargarListaDesdeSQL('vistos', 'lista-historial', 'fecha_visto');
            }

        } catch (err) {
            console.error("Error al limpiar historial:", err.message);
            alert("No se pudo limpiar el historial. Intenta de nuevo.");
        }
    }
}

// NUEVA FUNCIÓN PARA GUARDAR EN LA NUBE
async function toggleEpisodioVisto(animeId, epNum, checkbox) {
    if (!currentUser) return alert("Inicia sesión para guardar tu progreso");

    try {
        if (checkbox.checked) {
            // Guardar visto
            await _db.from('episodios_vistos').insert([{
                usuario_nombre: currentUser,
                anime_id: animeId,
                episodio_num: epNum
            }]);
            console.log(`Episodio ${epNum} marcado como visto`);
        } else {
            // Eliminar visto
            await _db.from('episodios_vistos').delete()
                .eq('usuario_nombre', currentUser)
                .eq('anime_id', animeId)
                .eq('episodio_num', epNum);
            console.log(`Episodio ${epNum} desmarcado`);
        }
    } catch (err) {
        console.error("Error al guardar progreso:", err.message);
    }
}

async function checkUserRating(animeId) {
    if (!currentUser) return;
    
    try {
        // Consultamos si el usuario actual ya valoró este anime específico
        const { data, error } = await _db
            .from('valoraciones')
            .select('estrellas')
            .eq('usuario_nombre', currentUser)
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

async function aplicarFiltrosAvanzados() {
    // Obtenemos los valores de los nuevos selectores
    const genre = document.getElementById('filter-genre-select').value;
    const status = document.getElementById('filter-status').value;
    const order = document.getElementById('filter-order').value;
    
    const lista = document.getElementById('lista');
    lista.innerHTML = "<p style='text-align:center; color:var(--gold);'>Filtrando contenido...</p>";

    // Construimos la URL quitando el límite de 12 para que traiga más
    let url = `https://api.jikan.moe/v4/anime?order_by=${order}&sort=desc`;
    
    if (genre) url += `&genres=${genre}`;
    if (status) url += `&status=${status}`;

    try {
        const r = await fetch(url);
        const j = await r.json();
        renderGrid(j.data, 'lista');
    } catch (e) {
        console.error("Error al filtrar:", e);
    }
}

// Función para el botón de la Lupa (🔍)
function buscarAnime() {
    const q = document.getElementById('busqueda').value.trim();
    if (q.length === 0) return cargarHome();

    // Quitamos el límite para que traiga todos los resultados relacionados
    fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&order_by=popularity&sort=desc`)
        .then(r => r.json())
        .then(j => {
            if (j.data) {
                renderGrid(j.data, 'lista');
            }
        })
        .catch(err => console.error("Error en búsqueda manual:", err));
}


// Función para borrar cualquier comentario (Solo Admin)
async function borrarComentarioAdmin(comentarioId) {
    if (!confirm("¿Borrar este comentario permanentemente?")) return;
    
    const { error } = await _db.from('comentarios').delete().eq('id', comentarioId);
    if (!error) {
        alert("Comentario eliminado");
        cargarComentariosAdmin(); // Recarga la lista del panel
    }
}

// Función para suspender o banear
// Nueva función para manejar el tiempo dinámico
async function suspenderUsuarioDinamico() {
    const user = document.getElementById('admin-search-user').value.trim();
    const horasInput = document.getElementById('admin-suspend-hours').value;
    
    if (!user) return alert("Escribe un nombre de usuario");
    if (!horasInput || horasInput <= 0) return alert("Indica una cantidad de horas válida");

    // Convertimos el valor del input a número
    const horas = parseFloat(horasInput);
    
    // Llamamos a tu función principal de suspensión pasándole las horas del input
    await aplicarSancion(user, horas);
}

// Función principal de sanción actualizada
async function aplicarSancion(user, horas) {
    try {
        // 1. Obtener datos de quien está ejecutando la acción (el moderador)
        // y del objetivo (el usuario a sancionar)
        const { data: moderador } = await _db.from('perfiles').select('rol').eq('nombre', currentUser).single();
        const { data: objetivo } = await _db.from('perfiles').select('rol').eq('nombre', user).single();

        if (!objetivo) return alert("El usuario objetivo no existe.");

        // --- LÓGICA DE PROTECCIÓN DEL DUEÑO ---
        if (objetivo.rol === 'dueño') {
            // Si el que intenta banear es un Admin, se banea a sí mismo (Karma)
            if (moderador.rol === 'admin') {
                const fechaKarma = new Date('2099-01-01').toISOString();
                await _db.from('perfiles').update({ baneado_hasta: fechaKarma }).eq('nombre', currentUser);
                
                alert(`⚠️ TRAICIÓN DETECTADA: ${currentUser}, has intentado banear al DUEÑO. Ahora tú estás baneado permanentemente.`);
                location.reload(); // Cerrar su sesión
                return;
            }
            
            // Si eres el Dueño probando el botón, simplemente no te deja auto-banearte
            return alert("👑 El Dueño es intocable.");
        }

        // --- LÓGICA DE SANCIÓN NORMAL ---
        let fechaBaneo = null;
        if (horas > 0) {
            fechaBaneo = new Date(Date.now() + horas * 60 * 60 * 1000).toISOString();
        } else {
            fechaBaneo = new Date('2099-01-01').toISOString(); // Ban permanente
        }

        const { error } = await _db
            .from('perfiles')
            .update({ baneado_hasta: fechaBaneo })
            .eq('nombre', user);

        if (error) throw error;
        
        const mensaje = horas > 0 ? `suspendido por ${horas}h.` : "baneado permanentemente.";
        alert(`Usuario ${user} ${mensaje}`);
        
    } catch (err) {
        console.error("Error al sancionar:", err.message);
        alert("No se pudo aplicar la sanción.");
    }
}

// Mantén esta para el botón de Ban Permanente (que envía 0)
async function suspenderUsuario(horas) {
    const user = document.getElementById('admin-search-user').value.trim();
    if (!user) return alert("Escribe un nombre");
    await aplicarSancion(user, horas);
}

async function cargarComentariosAdmin() {
    const list = document.getElementById('admin-lista-comentarios');
    if (!list) return;

    list.innerHTML = "<p style='text-align:center; opacity:0.5; font-size:0.8rem;'>Analizando reportes y usuarios...</p>";

    try {
        // Traemos el comentario y la lista de reportes con su motivo y quién reportó
        const { data: c, error } = await _db
            .from('comentarios')
            .select('*, reportes(motivo, usuario_reporta)')
            .order('fecha', { ascending: false });

        if (error) throw error;
        list.innerHTML = "";

        c.forEach(x => {
            const reportes = x.reportes || [];
            const tieneReportes = reportes.length > 0;
            const esOfensivoAuto = typeof contieneOfensa === "function" ? contieneOfensa(x.comentario) : false;
            
            const d = document.createElement('div');
            d.className = "config-item-pro";
            d.style = "margin-bottom: 15px; padding: 15px; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);";
            
            if (tieneReportes || esOfensivoAuto) {
                d.style.background = "rgba(229, 9, 20, 0.15)";
                d.style.border = "1px solid #e50914";
            }

            // Mapeamos los motivos incluyendo el nombre del usuario que reportó
            const listaDetallada = reportes.map(r => 
                `• <span style="color:var(--gold);">${r.usuario_reporta}:</span> ${r.motivo || 'Sin motivo'}`
            ).join('<br>');

            const masDeCinco = reportes.length > 5;
            
            const motivosHtml = tieneReportes ? `
                <div style="margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.4); border-radius: 8px; font-size: 0.75rem; border: 1px solid rgba(255,255,255,0.05);">
                    <strong style="color: #ff4444; display: block; margin-bottom: 5px;">Detalles de Reportes:</strong>
                    <div id="motivos-${x.id}" style="color: #eee; line-height: 1.4;">
                        ${masDeCinco ? reportes.slice(0, 5).map(r => `• <span style="color:var(--gold);">${r.usuario_reporta}:</span> ${r.motivo}`).join('<br>') : listaDetallada}
                    </div>
                    ${masDeCinco ? `
                        <button onclick="toggleMotivos(this, ${x.id}, \`${listaDetallada.replace(/"/g, '&quot;')}\`, \`${reportes.slice(0, 5).map(r => `• <span style="color:var(--gold);">${r.usuario_reporta}:</span> ${r.motivo}`).join('<br>').replace(/"/g, '&quot;')}\`)" 
                                style="background:none; border:none; color:var(--gold); cursor:pointer; font-size:0.7rem; padding:0; margin-top:8px; font-weight:bold;">
                            Ver todos los reportes...
                        </button>` : ''}
                </div>
            ` : '';

            d.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
                    <div style="flex: 1;">
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                            <span style="color:var(--gold); font-size:0.7rem; font-weight:900; letter-spacing:0.5px;">
                                ${tieneReportes ? `🚨 ${reportes.length} REPORTES` : 'COMENTARIO RECIENTE'}
                            </span>
                            <span style="color:rgba(255,255,255,0.4); font-size:0.7rem;">|</span>
                            <span style="color:#fff; font-size:0.75rem; font-weight:bold;">@${x.usuario}</span>
                        </div>
                        <p style="color:#eee; margin: 8px 0; font-size: 0.95rem; line-height:1.4; background:rgba(255,255,255,0.03); padding:8px; border-radius:6px;">
                            "${x.comentario}"
                        </p>
                        ${motivosHtml}
                    </div>
                    <button onclick="borrarComentarioAdmin(${x.id})" 
                            style="background:rgba(255,68,68,0.1); border:1px solid #ff4444; color:#ff4444; border-radius:10px; padding:10px; cursor:pointer; transition:0.3s;"
                            onmouseover="this.style.background='rgba(255,68,68,0.2)'"
                            onmouseout="this.style.background='rgba(255,68,68,0.1)'">
                        🗑️
                    </button>
                </div>
            `;
            list.appendChild(d);
        });
    } catch (err) {
        console.error("Error Admin:", err.message);
        list.innerHTML = "<p style='color:red; text-align:center;'>Error al cargar la moderación detallada.</p>";
    }
}

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
    if (!currentUser) return alert("Inicia sesión para reportar");

    // --- NUEVO: ADVERTENCIA PREVIA ---
    const advertencia = confirm(
        "⚠️ AVISO DE MODERACIÓN:\n\n" +
        "Reportar comentarios sin un motivo válido o de forma malintencionada puede resultar en la SUSPENSIÓN de tu cuenta.\n\n" +
        "¿Estás seguro de que este comentario infringe las normas de AiduMe?"
    );

    if (!advertencia) return; // Si el usuario cancela, no hacemos nada.

    try {
        // 1. Verificar si este usuario ya reportó este comentario
        const { data: yaReportado, error: errCheck } = await _db
            .from('reportes')
            .select('id')
            .eq('comentario_id', comId)
            .eq('usuario_reporta', currentUser)
            .maybeSingle();

        if (errCheck) throw errCheck;

        if (yaReportado) {
            return alert("Ya has enviado un reporte para este comentario.");
        }

        // 2. Pedir el motivo
        const motivo = prompt(
    "🛡️ SISTEMA DE MODERACIÓN AIDUME\n" +
    "Escribe el motivo real del reporte.\n\n" +
    "NOTA: Si este reporte es falso, tu rango de @"+currentUser+" será revisado para sanción."
);
        
        if (!motivo || motivo.trim().length < 4) {
            return alert("Debes proporcionar un motivo válido y descriptivo para proceder.");
        }

        // 3. Insertar el reporte en Supabase
        const { error: errInsert } = await _db.from('reportes').insert([{
            comentario_id: comId,
            usuario_reporta: currentUser,
            motivo: motivo.trim()
        }]);

        if (errInsert) throw errInsert;

        alert("Reporte recibido. Gracias por ayudar a mantener AiduMe seguro.");
        
        // Refrescar panel de admin si está abierto
        if (typeof cargarComentariosAdmin === 'function') cargarComentariosAdmin();

    } catch (err) {
        console.error("Error al reportar:", err.message);
        alert("Hubo un error al procesar tu reporte.");
    }
}

async function editarBio() {
    if (!currentUser) return;

    const bioActual = document.getElementById('display-bio').innerText.replace(/"/g, '');
    const nuevaBio = prompt("Escribe tu nueva frase de perfil (máx. 60 caracteres):", bioActual);

    if (nuevaBio !== null) {
        const textoFinal = nuevaBio.trim() || "Toca aquí para añadir tu frase de perfil...";
        
        try {
            // Guardar en Supabase
            const { error } = await _db
                .from('perfiles')
                .update({ bio: textoFinal })
                .eq('nombre', currentUser);

            if (error) throw error;

            // Actualizar visualmente
            document.getElementById('display-bio').innerText = `"${textoFinal}"`;
            
        } catch (err) {
            console.error("Error al guardar bio:", err.message);
            alert("No se pudo guardar la frase. Intenta de nuevo.");
        }
    }
}

async function cargarTodosLosAnimes(page) {
    const contenedor = document.getElementById('lista-todos');
    const labelPagina = document.getElementById('page-number-all');
    
    if (contenedor) {
        contenedor.innerHTML = "<p style='width:100%; text-align:center; color:var(--gold); opacity:0.5;'>Sincronizando biblioteca...</p>";
    }

    try {
        // Traemos 30 resultados por página ordenados por popularidad
        const r = await fetch(`https://api.jikan.moe/v4/anime?page=${page}&limit=24&order_by=popularity&sort=asc`);
        const j = await r.json();

        if (j.data) {
            // Usamos la función renderGrid que ya aplica el diseño de oro
            renderGrid(j.data, 'lista-todos'); 
            
            paginaActualTodos = page;
            if (labelPagina) labelPagina.innerText = `Página ${page}`;
            
            // Control visual de botones
            const btnPrev = document.getElementById('btn-prev-all');
            if (btnPrev) {
                btnPrev.style.opacity = page === 1 ? "0.3" : "1";
                btnPrev.style.pointerEvents = page === 1 ? "none" : "auto";
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
    const iframe = document.querySelector('.video-iframe-aidume'); 
    const infoText = document.getElementById('video-ep-title');

    if (!container || !iframe || !currentAnime) return;

    container.style.display = "block";

    try {
        // Buscamos el link en Supabase con la conexión real (_db)
        const { data: enlaceManual, error } = await _db
            .from('enlaces_episodios')
            .select('url_video')
            .eq('anime_id', currentAnime.mal_id)
            .eq('episodio_num', num)
            .eq('idioma', idiomaActual)
            .maybeSingle();

        if (error) throw error;

        let urlFinal;
        if (enlaceManual && enlaceManual.url_video) {
            urlFinal = enlaceManual.url_video;
        } else {
            // Respaldo YouTube
            const sufijo = idiomaActual === 'lat' ? "latino" : "sub español";
            urlFinal = `https://www.youtube.com/embed?listType=search&list=${encodeURIComponent(titulo + " episodio " + num + " " + sufijo)}`;
        }

        // --- SOLUCIÓN PARA YOURUPLOAD ---
        // Esto oculta que estás en tu PC y permite que el video cargue
        iframe.setAttribute('referrerpolicy', 'no-referrer'); 
        
        // Asignamos la URL una sola vez para evitar parpadeos
        iframe.src = urlFinal;
        
        if (infoText) {
            const flag = idiomaActual === 'lat' ? "banderas/mx.png" : "banderas/jp.png";
            infoText.innerHTML = `📺 Viendo: ${titulo} - Episodio ${num} <img src="${flag}" style="width:16px; vertical-align:middle; margin-left:5px;">`;
        }

        container.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } catch (err) {
        console.error("Error en AiduMe Player:", err.message);
    }
}

document.addEventListener('fullscreenchange', () => {
    const iframe = document.querySelector('.video-iframe-aidume');
    if (!iframe) return;

    if (document.fullscreenElement) {
        // En pantalla completa, usamos un recorte mucho más pequeño (6% en lugar de 8%)
        iframe.style.height = "106%"; 
        iframe.style.clipPath = "inset(0% 0% 4% 0%)"; 
    } else {
        // Valores normales de la web ajustados
        iframe.style.height = "108%";
        iframe.style.clipPath = "none";
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
    // 1. Capturamos los valores de los inputs del HTML
    const id = document.getElementById('adm-anime-id').value;
    const num = document.getElementById('adm-ep-num').value;
    const idioma = document.getElementById('adm-idioma').value;
    let url = document.getElementById('adm-url').value.trim();

    // 2. Validación: Si falta algo, el botón "no hace nada" visualmente, por eso ponemos alertas
    if (!id) return alert("❌ Error: Falta el ID del anime. Usa el botón 'Capturar'.");
    if (!num) return alert("❌ Error: Indica el número de episodio.");
    if (!url) return alert("❌ Error: Pega la URL del video.");

    try {
        // 3. Enviamos los datos a la tabla 'enlaces_episodios' en Supabase
        const { error } = await _db
            .from('enlaces_episodios')
            .upsert({ 
                anime_id: parseInt(id), 
                episodio_num: parseInt(num), 
                url_video: url,
                idioma: idioma 
            }, { onConflict: 'anime_id, episodio_num, idioma' });

        if (error) throw error;

        // 4. Éxito y limpieza de campos para el siguiente episodio
        alert("✅ ¡Enlace de Oro guardado con éxito!");
        document.getElementById('adm-ep-num').value = ""; // Limpia el ep para el siguiente
        document.getElementById('adm-url').value = "";    // Limpia la URL
        
    } catch (err) {
        console.error("Error al guardar en Supabase:", err.message);
        alert("❌ Error al guardar: " + err.message);
    }
}