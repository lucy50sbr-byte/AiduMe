let dataSaver = localStorage.getItem('data_saver') === 'true';

const AVATARES_RANGOS = [
    { id: '1', minLvl: 1, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix' },
    { id: '2', minLvl: 1, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Aneka' },
    { id: '3', minLvl: 5, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Lilly' }, 
    { id: '4', minLvl: 10, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jack' },  
    { id: '5', minLvl: 20, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Milo' },  
    { id: '6', minLvl: 50, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Zoe' }    
];

async function showPage(pId) {
    // --- NUEVO: Cerramos los detalles y detenemos el video al cambiar de pestaña ---
    hideDetails(); //

    // 1. Ocultar todas las páginas
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page')); //
    
    // 2. Mostrar la página seleccionada
    const targetPage = document.getElementById(pId); //
    if (targetPage) {
        targetPage.classList.add('active-page'); //
    }

    // 3. Lógica de carga según la página
    if (pId === 'home') {
        cargarHome(); //
    } else if (pId === 'admin-panel') { 
        cargarComentariosAdmin(); //
    } else if (pId === 'mis-listas') {
        // Carga de favoritos desde Supabase
        cargarListaDesdeSQL('favoritos', 'lista-favoritos', 'fecha_agregado'); //
    } else if (pId === 'historial') {
        // Carga de historial desde Supabase
        cargarListaDesdeSQL('vistos', 'lista-historial', 'fecha_visto'); //
    } else if (pId === 'calendario') {
        cargarCalendario(); //
    } else if (pId === 'perfil') {
        actualizarPerfilDesdeSQL(); //
    }

    // 4. Actualizar botones del menú inferior (Dorado/Active)
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active')); //
    const activeBtn = Array.from(document.querySelectorAll('.nav-item'))
        .find(n => n.getAttribute('onclick') && n.getAttribute('onclick').includes(pId)); //
    
    if (activeBtn) activeBtn.classList.add('active'); //
}

async function actualizarPerfilDesdeSQL() {
    if (!currentUser) return;

    try {
        const { data: perfil, error } = await _db
            .from('perfiles')
            .select('*')
            .eq('nombre', currentUser)
            .single();

        if (error) throw error;

        // --- 1. CÁLCULO DE DATOS ---
        const totalVistos = ((perfil.xp || 0) + ((perfil.nivel - 1) * 3));
        
        const fechaRegistro = new Date(perfil.fecha_registro);
        const hoy = new Date();
        const aniosAntiguedad = (hoy - fechaRegistro) / (1000 * 60 * 60 * 24 * 365.25);

        // --- 2. ACTUALIZACIÓN DE UI ---
        document.getElementById('display-user').innerText = perfil.nombre;
        document.getElementById('display-level').innerText = perfil.nivel;
        document.getElementById('stat-vistos').innerText = totalVistos;

        const horasTotales = Math.floor((totalVistos * 24) / 60);
        const elHoras = document.getElementById('stat-horas');
        if (elHoras) elHoras.innerText = horasTotales + "h";

        const elEdad = document.getElementById('display-age');
        if (elEdad) elEdad.innerText = perfil.edad || "--";

        const elBio = document.getElementById('display-bio');
        if (elBio) {
            elBio.innerText = perfil.bio ? `"${perfil.bio}"` : "Toca aquí para añadir tu frase de perfil...";
        }

        // --- 3. SISTEMA DE AVATARES POR RANGO (FUSIONADO) ---
        // Recuperamos el ID del avatar guardado o el '1' por defecto
        const avatarActualId = perfil.avatar_id || '1';
        const avatarEncontrado = AVATARES_RANGOS.find(av => av.id === avatarActualId);

        if (avatarEncontrado) {
            // Actualizamos la foto en el perfil y en la barra de navegación
            document.getElementById('user-avatar').src = avatarEncontrado.img;
            if (document.getElementById('nav-avatar')) {
                document.getElementById('nav-avatar').src = avatarEncontrado.img;
            }
        }
        
        // Renderizamos la rejilla de selección para mostrar bloqueos por nivel
        renderAvatarSelector(perfil.nivel, avatarActualId);

        // --- 4. CONDECORACIONES ---
        const [comentariosRes, reportesEfectivos] = await Promise.all([
            _db.from('comentarios').select('*', { count: 'exact', head: true }).eq('usuario', currentUser),
            _db.from('reportes').select('id', { count: 'exact', head: true }).eq('usuario_reporta', currentUser)
        ]);

        const condecoraciones = {
            nivel50: perfil.nivel >= 50,
            unAnio: aniosAntiguedad >= 1,
            justiciero: comentariosRes.count >= 60 && reportesEfectivos.count >= 30,
            pionero: perfil.id <= 100,
            veterano3: aniosAntiguedad >= 3
        };

        renderCondecoraciones(condecoraciones);

    } catch (err) {
        console.error("Error en perfil:", err);
    }
}

function renderCondecoraciones(cond) {
    const container = document.querySelector('.badge-grid-pro');
    if (!container) return;
    container.innerHTML = ""; // Limpiar

    const lista = [
        { tiene: cond.nivel50, img: "1.png", txt: "Medalla del Dragon: Nivel 50 alcanzado" },
        { tiene: cond.unAnio, img: "2.png", txt: "Escudo de Valkyrias: 1 año en AiduMe" },
        { tiene: cond.justiciero, img: "3.png", txt: "Emblema León del fuego: 60 comentarios y 30 reportes válidos" },
        { tiene: cond.pionero, img: "4.png", txt: "Cruz de Honor: De los primeros 100 usuarios" },
        // La 5 queda reservada para Premium
        { tiene: cond.veterano3, img: "6.png", txt: "Orbe Estelar: 3 años de antigüedad" }
    ];

    lista.forEach(item => {
        if (item.tiene) {
            const el = document.createElement('img');
            el.src = `insignias/${item.img}`;
            el.className = "condecoracion-img";
            el.title = item.txt; // Tooltip al pasar el mouse
            el.onclick = () => alert(item.txt); // Feedback al tocar en móvil
            container.appendChild(el);
        }
    });
}

// FUNCIÓN MAESTRA PARA TRAER FAVORITOS O VISTOS
async function cargarListaDesdeSQL(tabla, contenedorId, columnaOrden) {
    const container = document.getElementById(contenedorId);
    if (!container) return;
    container.innerHTML = `<p style='text-align:center; color:var(--gold);'>Sincronizando ${tabla}...</p>`;

    if (!currentUser) {
        container.innerHTML = "<p style='text-align:center;'>Inicia sesión para ver tu lista</p>";
        return;
    }

    try {
        const { data, error } = await _db
            .from(tabla)
            .select('*')
            .eq('usuario_nombre', currentUser)
            .order(columnaOrden, { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            container.innerHTML = "<p style='text-align:center; opacity:0.5;'>No hay animes en esta sección</p>";
            return;
        }

        const dataAdaptada = data.map(item => ({
            mal_id: item.anime_id,
            title: item.titulo,
            images: { jpg: { image_url: item.imagen_url } }
        }));

        renderGrid(dataAdaptada, contenedorId);

    } catch (err) {
        console.error(`Error en tabla ${tabla}:`, err.message);
        container.innerHTML = "<p style='text-align:center; color:red;'>Error de conexión con SQL</p>";
    }
}

function renderGrid(data, id) {
    const container = document.getElementById(id);
    if (!container) return;
    
    container.innerHTML = data.length ? "" : "<p style='text-align:center; opacity:0.5; padding:20px;'>No hay resultados.</p>";
    
    data.forEach(a => {
        const div = document.createElement('div');
        div.className = 'card';
        div.onclick = () => showDetails(a);
        
        // Buscamos título en español, si no, el original
        const titleEs = a.titles ? a.titles.find(t => t.type === 'Spanish')?.title : null;
        const nombreMostrar = titleEs || a.title || "Sin título";

        // Elegimos imagen según modo ahorro
        const imgUrl = (dataSaver && a.images?.jpg?.small_image_url) 
            ? a.images.jpg.small_image_url 
            : (a.images?.jpg?.image_url || 'placeholder.png');

        div.innerHTML = `
            <img src="${imgUrl}" loading="lazy" alt="${nombreMostrar}">
            <div class="card-title">${nombreMostrar}</div>
        `;
        
        container.appendChild(div);
    });
}

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', document.body.classList.contains('light-mode') ? 'light' : 'dark');
}

function toggleDataSaver() {
    dataSaver = !dataSaver;
    localStorage.setItem('data_saver', dataSaver);
}

function updateStars(stars, locked) {
    const status = document.getElementById('rating-status');
    const starBox = document.getElementById('star-box');
    const estrellas = document.querySelectorAll('.star');

    estrellas.forEach((s, i) => {
        // 1. Resetear y aplicar color dorado si el índice es menor a la puntuación
        s.classList.remove('active', 'locked');
        if (i < stars) {
            s.classList.add('active');
        }
        
        // 2. Aplicar estilo de bloqueo si ya está votado
        if (locked) {
            s.classList.add('locked');
            s.style.opacity = "0.5";
        } else {
            s.style.opacity = "1";
        }
    });

    // 3. Bloquear o desbloquear clics en el contenedor
    if (starBox) {
        starBox.style.pointerEvents = locked ? "none" : "auto";
    }

    // 4. Actualizar el texto debajo de las estrellas
    if (status) {
        if (stars > 0) {
            status.innerText = locked ? "VOTO PERMANENTE" : "TU CALIFICACIÓN";
            status.style.color = "var(--gold)";
        } else {
            status.innerText = "CALIFICA ESTE ANIME";
            status.style.color = "inherit";
        }
    }
}


if(localStorage.getItem('theme') === 'light') document.body.classList.add('light-mode');

function toggleSynopsis() {
    const syn = document.getElementById('dt-synopsis');
    const btn = document.getElementById('btn-read-more');
    
    // Alternamos la clase 'expanded'
    syn.classList.toggle('expanded');

    if (syn.classList.contains('expanded')) {
        btn.innerText = "Ver menos";
    } else {
        btn.innerText = "Ver más...";
        // Scroll opcional para no perderse al cerrar
        syn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function toggleFilterPanel() {
    const panel = document.getElementById('filter-panel');
    const icon = document.getElementById('filter-icon');
    if (!panel) return;

    const isOpen = panel.style.display === "block";
    panel.style.display = isOpen ? "none" : "block";
    if (icon) icon.innerText = isOpen ? "▼" : "▲";
}

// AGREGA ESTA FUNCIÓN AL FINAL DE ui.js
function scrollSection(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const scrollAmount = 450; // Desplaza 3 animes aprox.
    const isAtEnd = container.scrollLeft + container.clientWidth >= container.scrollWidth - 10;

    if (isAtEnd) {
        container.scrollTo({ left: 0, behavior: 'smooth' });
    } else {
        container.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
}

function checkUser() {
    const data = JSON.parse(localStorage.getItem('aidume_profile'));
    if (data) {
        currentUser = data.name;
        
        const overlay = document.getElementById('auth-overlay');
        if (overlay) overlay.style.display = 'none';

        if (document.getElementById('display-user')) {
            document.getElementById('display-user').innerText = data.name;
        }

        // --- NUEVO: ACTUALIZACIÓN DEL AVATAR EN LA BARRA DE NAVEGACIÓN ---
        if (document.getElementById('nav-avatar')) {
            document.getElementById('nav-avatar').src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${data.name}`;
        }

        // LÓGICA DE ACCESO A MODERACIÓN (Admin y Dueño)
        if (data.rol === 'admin' || data.rol === 'dueño') {
            const nav = document.querySelector('.bottom-nav');
            const yaExiste = document.querySelector('div[onclick*="admin-panel"]');
            
            if (nav && !yaExiste) {
                // Personalizamos el icono y texto según el rango
                const esDueño = data.rol === 'dueño';
                const icono = esDueño ? '👑' : '🛡️';
                const etiqueta = esDueño ? 'Owner' : 'Admin';

                // Inyectamos el botón correspondiente en el menú inferior
                nav.innerHTML += `
                    <div class="nav-item" onclick="showPage('admin-panel')">
                        <i>${icono}</i>${etiqueta}
                    </div>`;
            }
        }
        
        if (typeof initApp === 'function') initApp(); 
    }
}

function abrirModalNormas() {
    const modal = document.getElementById('modal-normas');
    if (modal) {
        modal.style.display = 'flex';
        modal.style.alignItems = 'center'; // Centra el contenido
    }
}

function cerrarModalNormas() {
    const modal = document.getElementById('modal-normas');
    if (modal) modal.style.display = 'none';
}

async function renderAvatarSelector(nivelUsuario, avatarActualId) {
    const grid = document.getElementById('avatar-selector-grid');
    if (!grid) return;
    grid.innerHTML = "";

    AVATARES_RANGOS.forEach(av => {
        const esDesbloqueado = nivelUsuario >= av.minLvl;
        const esSeleccionado = avatarActualId === av.id;

        const img = document.createElement('img');
        img.src = av.img;
        img.className = `avatar-option ${esDesbloqueado ? 'unlocked' : 'locked'} ${esSeleccionado ? 'selected' : ''}`;
        
        if (esDesbloqueado) {
            img.onclick = () => cambiarAvatar(av.id, av.img);
        } else {
            img.onclick = () => alert(`Necesitas Nivel ${av.minLvl} para desbloquear este avatar.`);
        }
        
        grid.appendChild(img);
    });
}


function abrirSelectorAvatar() {
    const modal = document.getElementById('modal-avatar');
    if (modal) modal.style.display = 'flex';
}

function cerrarSelectorAvatar() {
    const modal = document.getElementById('modal-avatar');
    if (modal) modal.style.display = 'none';
}

async function cambiarAvatar(id, url) {
    if (!currentUser) return;

    try {
        // Actualizamos la columna que acabas de crear
        const { error } = await _db
            .from('perfiles')
            .update({ avatar_id: id }) 
            .eq('nombre', currentUser);

        if (error) throw error;

        // Actualizamos las imágenes en tiempo real
        if (document.getElementById('user-avatar')) document.getElementById('user-avatar').src = url;
        if (document.getElementById('nav-avatar')) document.getElementById('nav-avatar').src = url;

        cerrarSelectorAvatar();
        actualizarPerfilDesdeSQL(); // Refresca para aplicar cambios
        
    } catch (err) {
        console.error("Error al guardar avatar:", err.message);
        alert("Asegúrate de que la columna 'avatar_id' ya esté guardada en Supabase.");
    }
}

function hideDetails() { 
    const details = document.getElementById('details');
    // CAMBIO AQUÍ: También usamos la clase para encontrar el iframe y apagarlo
    const iframe = document.querySelector('.video-iframe-aidume');
    const videoContainer = document.getElementById('video-player-container');
    const videoInfo = document.getElementById('video-ep-title');

    if (details) details.style.display = "none";
    
    if (iframe) iframe.src = ""; // Detener audio/video correctamente

    if (videoContainer) videoContainer.style.display = "none";

    if (videoInfo) videoInfo.innerText = "";
}

// Único disparador al cargar la web
window.addEventListener('load', checkUser);