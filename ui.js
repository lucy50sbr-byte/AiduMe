let dataSaver = localStorage.getItem('data_saver') === 'true';

// Variables globales para Mercado Pago
let mp = null;
let cardFields = null;
let usuarioEnPantalla = null; // Variable global para saber qué perfil estamos viendo

function lanzarConfetiGold() {
    if (typeof confetti !== 'undefined') {
        const duration = 3 * 1000;
        const animationEnd = Date.now() + duration;
        const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 11000 };

        const randomInRange = (min, max) => Math.random() * (max - min) + min;

        const interval = setInterval(function() {
            const timeLeft = animationEnd - Date.now();

            if (timeLeft <= 0) {
                return clearInterval(interval);
            }

            const particleCount = 50 * (timeLeft / duration);
            // Lluvia de oro y blanco desde ángulos aleatorios
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 }, colors: ['#ffd700', '#ffffff', '#ffcc00'] });
            confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 }, colors: ['#ffd700', '#ffffff', '#ffcc00'] });
        }, 250);
    }
}

const AVATARES_RANGOS = [
    { id: '1', minLvl: 1, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix' },
    { id: '2', minLvl: 1, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Aneka' },
    { id: '3', minLvl: 5, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Lilly' }, 
    { id: '4', minLvl: 10, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jack' },  
    { id: '5', minLvl: 20, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Milo' },  
    { id: '6', minLvl: 50, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Zoe' }    
];

const AVATARES_TIENDA = [
    { id: 'shop_1', costo: 100, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Goku', nombre: 'Guerrero Z' },
    { id: 'shop_2', costo: 250, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Luffy', nombre: 'Pirata' },
    { id: 'shop_3', costo: 500, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Naruto', nombre: 'Ninja' },
    { id: 'shop_4', costo: 1000, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Ichigo', nombre: 'Shinigami' },
    { id: 'shop_5', costo: 1500, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Zenitsu', nombre: 'Rayo Dorado' },
    { id: 'shop_6', costo: 2000, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Saitama', nombre: 'Calvo de Oro' },
    { id: 'shop_7', costo: 3000, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Sasuke', nombre: 'Vengador' },
    { id: 'shop_8', costo: 5000, img: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Zoro', nombre: 'Espadachín' }
];

const TEMAS_CHAT = [
    { id: 'neon', costo: 800, nombre: 'Ciber Neón', class: 'msg-skin-neon', color: '#00d4ff' },
    { id: 'sakura', costo: 1200, nombre: 'Flor Sakura', class: 'msg-skin-sakura', color: '#ff85a1' },
    { id: 'inferno', costo: 2500, nombre: 'Infierno', class: 'msg-skin-inferno', color: '#ff4500' },
    { id: 'emerald', costo: 4000, nombre: 'Esmeralda', class: 'msg-skin-emerald', color: '#2ecc71' }
];

// Definición de los 10 paquetes comprables (11-110)
const STICKER_PACKS_TIENDA = [
    { id: 'stk_pack_2', costo: 500, nombre: 'Pack Ninja', inicio: 11, fin: 20 },
    { id: 'stk_pack_3', costo: 500, nombre: 'Pack Acción', inicio: 21, fin: 30 },
    { id: 'stk_pack_4', costo: 800, nombre: 'Pack Super', inicio: 31, fin: 40 },
    { id: 'stk_pack_5', costo: 800, nombre: 'Pack Kawaii', inicio: 41, fin: 50 },
    { id: 'stk_pack_6', costo: 1000, nombre: 'Pack Demon', inicio: 51, fin: 60 },
    { id: 'stk_pack_7', costo: 1000, nombre: 'Pack Mecha', inicio: 61, fin: 70 },
    { id: 'stk_pack_8', costo: 1500, nombre: 'Pack Gore', inicio: 71, fin: 80 },
    { id: 'stk_pack_9', costo: 1500, nombre: 'Pack Retro', inicio: 81, fin: 90 },
    { id: 'stk_pack_10', costo: 2000, nombre: 'Pack Titan', inicio: 91, fin: 100 },
    { id: 'stk_pack_11', costo: 3000, nombre: 'Pack Dios', inicio: 101, fin: 110 }
];

function abrirTienda() {
    const modal = document.getElementById('modal-tienda');
    const grid = document.getElementById('tienda-avatares-grid');
    if (!modal || !grid) return;

    toggleTiendaSeccion(null); // Asegura que todo inicie cerrado

    grid.innerHTML = "";
    AVATARES_TIENDA.forEach(av => {
        const div = document.createElement('div');
        div.className = "avatar-buy-card";
        div.innerHTML = `
            <img src="${av.img}" style="width:50px; border-radius:50%; border: 1px solid var(--gold); background:#111;">
            <div style="font-size:0.6rem; color:#fff; margin:5px 0;">${av.nombre}</div>
            <button onclick="comprarAvatar('${av.id}', ${av.costo}, '${av.img}')" 
                    style="background:var(--gold); border:none; border-radius:5px; font-size:0.6rem; padding:4px 8px; cursor:pointer; font-weight:bold;">
                💰 ${av.costo}
            </button>
        `;
        grid.appendChild(div);
    });

    // Cargar Temas
    const gridTemas = document.getElementById('tienda-temas-grid');
    if (gridTemas) {
        gridTemas.innerHTML = "";
        TEMAS_CHAT.forEach(t => {
            const div = document.createElement('div');
            div.className = "chat-skin-card";
            div.innerHTML = `
                <div style="width:20px; height:20px; background:${t.color}; border-radius:50%; margin:0 auto 5px; box-shadow: 0 0 10px ${t.color};"></div>
                <div style="font-size:0.55rem; color:#fff; margin-bottom:5px;">${t.nombre}</div>
                <button onclick="comprarTema('${t.id}', ${t.costo})" 
                        style="background:var(--gold); border:none; border-radius:5px; font-size:0.55rem; padding:4px 6px; cursor:pointer; font-weight:bold;">💰 ${t.costo}</button>
            `;
            gridTemas.appendChild(div);
        });
    }

    // Cargar Stickers en la Tienda
    const gridStickers = document.getElementById('tienda-stickers-grid');
    if (gridStickers) {
        gridStickers.innerHTML = "";
        STICKER_PACKS_TIENDA.forEach(p => {
            const div = document.createElement('div');
            div.className = "chat-skin-card";
            div.innerHTML = `
                <img src="stickers/${p.inicio}.gif" style="width:30px; height:30px; object-fit:contain; margin-bottom:5px;">
                <div style="font-size:0.55rem; color:#fff; margin-bottom:5px;">${p.nombre}</div>
                <button onclick="comprarStickerPack('${p.id}', ${p.costo})" 
                        style="background:var(--gold); border:none; border-radius:5px; font-size:0.55rem; padding:4px 6px; cursor:pointer; font-weight:bold;">💰 ${p.costo}</button>`;
            gridStickers.appendChild(div);
        });
    }

    modal.style.display = 'flex';
}

function toggleTiendaSeccion(id) {
    const secciones = ['tienda-avatares-grid', 'tienda-temas-grid', 'tienda-stickers-grid'];
    secciones.forEach(sId => {
        const el = document.getElementById(sId);
        if (!el) return;
        
        const btn = el.previousElementSibling;
        const arrow = btn ? btn.querySelector('.arrow') : null;

        if (sId === id) {
            const isHidden = el.style.display === 'none' || el.style.display === '';
            el.style.display = isHidden ? 'grid' : 'none';
            if (arrow) arrow.innerText = isHidden ? '▲' : '▼';
        } else {
            el.style.display = 'none';
            if (arrow) arrow.innerText = '▼';
        }
    });
}

function cerrarTienda() { document.getElementById('modal-tienda').style.display = 'none'; }

async function comprarAvatar(id, costo, imgUrl) {
    const { data: perfil } = await _db.from('perfiles').select('aidufichas, avatares_comprados').eq('nombre', currentUser).single();
    
    if (perfil.aidufichas < costo) {
        return goldAlert({ title: "FICHAS INSUFICIENTES", text: `Necesitas ${costo} Aidufichas. ¡Sigue viendo anime para ganar más!`, icon: "📉" });
    }

    const confirmar = await goldAlert({
        title: "CONFIRMAR COMPRA",
        text: `¿Quieres canjear ${costo} fichas por este avatar?`,
        icon: "🛒",
        showCancel: true
    });

    if (confirmar) {
        const nuevasFichas = perfil.aidufichas - costo;
        // Actualizamos fichas, el avatar actual y lo agregamos a la lista de comprados
        const listaActualizada = [...(perfil.avatares_comprados || []), id];

        await _db.from('perfiles').update({ 
            aidufichas: nuevasFichas, 
            avatar_id: id,
            avatares_comprados: listaActualizada 
        }).eq('nombre', currentUser);

        lanzarConfetiGold();
        goldAlert({ title: "¡COMPRA EXITOSA!", text: "Tu nuevo avatar ha sido equipado.", icon: "✨" });
        cerrarTienda();
        actualizarPerfilDesdeSQL();
    }
}

async function comprarTema(id, costo) {
    const { data: perfil } = await _db.from('perfiles').select('aidufichas, temas_comprados').eq('nombre', currentUser).single();
    
    if (perfil.temas_comprados?.includes(id)) {
        // Si ya lo tiene, simplemente lo equipamos
        await _db.from('perfiles').update({ tema_chat: id }).eq('nombre', currentUser);
        goldAlert({ title: "TEMA EQUIPADO", text: "Has cambiado el skin de tus mensajes.", icon: "✨" });
        actualizarPerfilDesdeSQL();
        if(typeof aplicarTemaChatLocal === 'function') aplicarTemaChatLocal();
        if(typeof cargarMensajesChat === 'function') cargarMensajesChat();
        return cerrarTienda();
    }

    if (perfil.aidufichas < costo) {
        return goldAlert({ title: "FICHAS INSUFICIENTES", text: `Necesitas ${costo} fichas para este skin.`, icon: "📉" });
    }

    const confirmar = await goldAlert({ title: "COMPRAR SKIN", text: `¿Quieres desbloquear el tema por ${costo} fichas?`, icon: "✨", showCancel: true });

    if (confirmar) {
        const nuevaLista = [...(perfil.temas_comprados || []), id];
        await _db.from('perfiles').update({ 
            aidufichas: perfil.aidufichas - costo, 
            temas_comprados: nuevaLista,
            tema_chat: id 
        }).eq('nombre', currentUser);
        
        lanzarConfetiGold();
        goldAlert({ title: "¡DESBLOQUEADO!", text: "Nuevo skin de chat activado.", icon: "🔥" });
        actualizarPerfilDesdeSQL();
        if(typeof aplicarTemaChatLocal === 'function') aplicarTemaChatLocal();
        if(typeof cargarMensajesChat === 'function') cargarMensajesChat();
        cerrarTienda();
    }
}

async function comprarStickerPack(id, costo) {
    const { data: perfil } = await _db.from('perfiles').select('aidufichas, stickers_comprados').eq('nombre', currentUser).single();
    
    if (perfil.stickers_comprados?.includes(id)) {
        return goldAlert({ title: "YA LO TIENES", text: "Este paquete de stickers ya está en tu colección.", icon: "🖼️" });
    }

    if (perfil.aidufichas < costo) {
        return goldAlert({ title: "FICHAS INSUFICIENTES", text: `Necesitas ${costo} fichas para este pack.`, icon: "📉" });
    }

    const confirmar = await goldAlert({ title: "COMPRAR PACK", text: `¿Quieres desbloquear este paquete por ${costo} fichas?`, icon: "🖼️", showCancel: true });

    if (confirmar) {
        const nuevaLista = [...(perfil.stickers_comprados || []), id];
        await _db.from('perfiles').update({ 
            aidufichas: perfil.aidufichas - costo, 
            stickers_comprados: nuevaLista
        }).eq('nombre', currentUser);
        
        lanzarConfetiGold();
        goldAlert({ title: "¡DESBLOQUEADO!", text: "Nuevo paquete de stickers listo para usar.", icon: "✨" });
        actualizarPerfilDesdeSQL();
        cerrarTienda();
    }
}

function mostrarCheckoutInterno() {
    const panel = document.getElementById('checkout-interno');
    if (panel) panel.style.display = 'block';
    panel.scrollIntoView({ behavior: 'smooth' });
}

async function mostrarCheckoutTarjeta() {
    document.getElementById('checkout-interno').style.display = 'none'; // Oculta el checkout manual
    const panel = document.getElementById('checkout-tarjeta'); // Muestra el panel de tarjeta
    if (panel) {
        panel.style.display = 'block';
        panel.scrollIntoView({ behavior: 'smooth' });

        // Inicializa Mercado Pago SDK si no está listo
        if (typeof MercadoPago !== 'undefined' && !mp) {
            // Credenciales de Producción
            mp = new MercadoPago('APP_USR-de1dc75b-248c-461a-9691-7ec9b641e8a7', { locale: 'es-AR' });
        }

        // Solo crea los campos de tarjeta si mp está inicializado y los campos no han sido creados
        if (mp && !cardFields) {
            const fields = mp.fields; // Obtiene la instancia de los campos (sin paréntesis)
            const style = {
                color: "#ffffff",
                fontSize: "16px",
                fontFamily: "Segoe UI",
                placeholder: { color: "#888888" } // Estilo para el placeholder
            };

            cardFields = {
                number: fields.create('cardNumber', { placeholder: "0000 0000 0000 0000", style }).mount('cardNumber'),
                expiration: fields.create('expirationDate', { placeholder: "MM/YY", style }).mount('expirationDate'),
                securityCode: fields.create('securityCode', { placeholder: "CVV", style }).mount('securityCode')
            };
        }
    }
}

async function procesarPagoTarjeta() {
    const btn = document.getElementById('btn-pagar-tarjeta');
    const name = document.getElementById('card-name').value.trim();
    const dni = document.getElementById('card-dni').value.trim();

    if (!name) return goldAlert({ title: "ERROR", text: "Ingresa el nombre del titular.", icon: "💳" });
    if (dni.length < 7) return goldAlert({ title: "ERROR", text: "Ingresa un DNI válido.", icon: "🆔" });
    if (!mp || !cardFields) return goldAlert({ title: "ERROR", text: "El sistema de pago no está listo. Intenta de nuevo.", icon: "❌" });

    btn.disabled = true;
    btn.innerText = "TOKENIZANDO...";

    try {
        const tokenResponse = await mp.fields.createCardToken({ cardholderName: name });
        
        if (tokenResponse.errors) {
            console.error("Errores de validación MP:", tokenResponse.errors);
            throw new Error("Datos de tarjeta inválidos. Revisa el número, fecha y CVV.");
        }

        const token = tokenResponse.id;
        const bin = tokenResponse.first_six_digits;

        if (!token) throw new Error("No se pudo generar el token de seguridad de la tarjeta.");

        // Detectamos el método de pago (Visa, Mastercard, etc) usando el BIN
        const paymentMethods = await mp.getPaymentMethods({ bin });
        if (!paymentMethods.results || paymentMethods.results.length === 0) {
            throw new Error("No se pudo identificar el tipo de tarjeta (Visa/Mastercard). Revisa el número.");
        }
        const payment_method_id = paymentMethods.results[0].id;
        const issuer_id = paymentMethods.results[0].issuer?.id;

        btn.innerText = "PROCESANDO PAGO...";

        const { data: p } = await _db.from('perfiles').select('email').ilike('nombre', currentUser).single();
        const validEmail = (p?.email && p.email.includes('@')) ? p.email : `${currentUser.toLowerCase()}@aidume.com`;

        // Enviamos el token generado por MP a nuestra Edge Function
        const { data, error: funcError } = await _db.functions.invoke('verify-payment', {
            body: {
                usuario: currentUser,
                metodo: 'mercadopago',
                email: validEmail,
                dni: dni,
                token: token,
                payment_method_id: payment_method_id,
                issuer_id: issuer_id,
                installments: 1
            }
        });

        if (funcError) {
            console.error("Error en Edge Function:", funcError);

            let errorMessage = funcError.message || "Error en el servidor de pagos.";
            // Detectamos el estado 402 de forma flexible (número o string)
            let isPending = (funcError.status == 402); 

            try {
                if (funcError.context && typeof funcError.context.json === 'function') {
                    const errBody = await funcError.context.json();
                    errorMessage = errBody.details || errBody.message || errorMessage;
                    
                    // Normalizamos el texto (quitamos acentos y pasamos a minúsculas) para una búsqueda segura
                    const msgNormal = errorMessage.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    if (msgNormal.includes("revision") || msgNormal.includes("pendiente")) {
                        isPending = true;
                    }
                }
            } catch (e) {
                console.warn("No se pudo leer el cuerpo del error.");
            }

            if (isPending) {
                return goldAlert({ 
                    title: "PAGO EN PROCESO", 
                    text: errorMessage, 
                    icon: "⏳" 
                });
            }
            throw new Error(errorMessage);
        }

        if (!data || data.message !== 'Pago aprobado.') {
            throw new Error(data?.details || data?.message || "El pago no pudo ser verificado.");
        }

        lanzarConfetiGold();
        const perfilLocal = JSON.parse(localStorage.getItem('aidume_profile'));
        if (perfilLocal) { perfilLocal.premium = true; localStorage.setItem('aidume_profile', JSON.stringify(perfilLocal)); }

        await goldAlert({ title: "¡PAGO EXITOSO!", text: "Ya eres miembro PREMIUM.", icon: "👑" });
        location.reload();

    } catch (err) {
        console.error(err);
        goldAlert({ title: "ERROR", text: err.message, icon: "❌" });
    } finally {
        btn.disabled = false;
        btn.innerText = "PAGAR $400 ARS"; 
    }
}

async function enviarComprobantePago() {
    const ref = document.getElementById('pago-referencia').value.trim();
    
    if (ref.length < 5) {
        return goldAlert({ title: "ID INVÁLIDO", text: "Por favor, ingresa un número de operación válido para verificar.", icon: "❌" });
    }

    try {
        // Simulación para transferencia: Simplemente enviamos un aviso de "Pendiente"
        await new Promise(resolve => setTimeout(resolve, 1500));

        goldAlert({
            title: "SOLICITUD ENVIADA",
            text: "Tu comprobante #" + ref + " ha sido recibido. Un administrador lo revisará pronto para activar tu rango.",
            icon: "⏳"
        });
        
        cerrarTienda();
    } catch (err) {
        console.error(err);
        goldAlert({ title: "ERROR", text: "No pudimos procesar la solicitud. Intenta más tarde.", icon: "❌" });
    }
}

async function showPage(pId) {
    // 1. RECARGA NUCLEAR MEJORADA
    // Si hay un video y cambiamos de página, recargamos para limpiar RAM y audio
    const videoContainer = document.getElementById('video-player-container');
    const iframeActivo = videoContainer ? videoContainer.querySelector('iframe') : null;

    if (iframeActivo && videoContainer.style.display !== "none" && iframeActivo.src !== "") {
        // Guardamos el destino para que al recargar sepa a dónde ir
        window.location.hash = pId;
        window.location.reload();
        return; 
    }

    // 2. NAVEGACIÓN NORMAL
    hideDetails(); // Cerramos cualquier overlay de detalles abierto

    // Ocultar todas las páginas y quitar clases activas
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page')); 
    
    // Mostrar la página seleccionada
    const targetPage = document.getElementById(pId);
    if (targetPage) {
        targetPage.classList.add('active-page');
        // Aseguramos que el scroll vuelva arriba al cambiar de pestaña
        window.scrollTo(0, 0);
    }

    // 3. LÓGICA DE CARGA SEGÚN LA PÁGINA
    switch(pId) {
        case 'home': cargarHome(); break;
        case 'admin-panel': cargarComentariosAdmin(); break;
        case 'mis-listas': cargarListaDesdeSQL('favoritos', 'lista-favoritos', 'fecha_agregado'); break;
        case 'historial': cargarListaDesdeSQL('vistos', 'lista-historial', 'fecha_visto'); break;
        case 'calendario': cargarCalendario(); break;
        case 'perfil': actualizarPerfilDesdeSQL(); break;
    }

    // 4. ASEGURAR VISIBILIDAD DE LA NAV BAR
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) {
        // En estas páginas la barra SIEMPRE debe estar visible (flex)
        bottomNav.style.display = "flex"; 
    }

    // 5. ACTUALIZAR ESTADO VISUAL DE LOS BOTONES (Dorado/Active)
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active');
        // Verificamos si el onclick del botón contiene el ID de la página actual
        const clickAction = n.getAttribute('onclick') || "";
        if (clickAction.includes(`'${pId}'`) || clickAction.includes(`"${pId}"`)) {
            n.classList.add('active');
        }
    });
}

// --- ESCUCHADOR DE RECARGA ---
// Pon esto justo debajo de la función showPage para que la app 
// abra la pestaña correcta después de refrescarse por el video.
window.addEventListener('load', () => {
    const hashDestino = window.location.hash.replace('#', '');
    if (hashDestino) {
        // Esperamos un momento a que el DOM y Supabase estén listos
        setTimeout(() => {
            showPage(hashDestino);
            // Limpiamos la URL para que no recargue en el futuro innecesariamente
            window.history.replaceState(null, null, ' ');
        }, 100);
    }
});

// Agregamos el parámetro 'nombreAMostrar' que por defecto es el usuario actual
async function actualizarPerfilDesdeSQL(nombreAMostrar = currentUser) {
    if (!nombreAMostrar) return;

    // --- NUEVO: Guardamos el nombre del usuario que estamos viendo ---
    usuarioEnPantalla = nombreAMostrar;

    const esMismoUsuario = (currentUser === nombreAMostrar);

    // --- 0. PREPARACIÓN DE UI Y PRIVACIDAD ---
    const elementos = {
        btnAvatar: document.querySelector('.btn-add-avatar'),
        settings: document.querySelector('.settings-container'),
        btnNormas: document.querySelector('.btn-normas'),
        elBio: document.getElementById('display-bio'),
        elUser: document.getElementById('display-user'),
        elLevel: document.getElementById('display-level'),
        elRank: document.getElementById('display-rank'),
        elVistos: document.getElementById('stat-vistos'),
        elHoras: document.getElementById('stat-horas'),
        elFichas: document.getElementById('stat-fichas'),
        elEdad: document.getElementById('display-age'),
        elXPBar: document.getElementById('xp-bar'),
        elXPText: document.getElementById('xp-text'),
        imgAvatar: document.getElementById('user-avatar'),
        navAvatar: document.getElementById('nav-avatar')
    };

    // Control de visibilidad de herramientas de edición
    if (elementos.btnAvatar) elementos.btnAvatar.style.display = esMismoUsuario ? 'flex' : 'none';
    if (elementos.settings) elementos.settings.style.display = esMismoUsuario ? 'block' : 'none';
    if (elementos.btnNormas) elementos.btnNormas.style.display = esMismoUsuario ? 'flex' : 'none';
    
    if (elementos.elBio) {
        elementos.elBio.onclick = esMismoUsuario ? editarBio : null;
        elementos.elBio.style.cursor = esMismoUsuario ? 'pointer' : 'default';
    }

    try {
        // --- 1. FETCH DE DATOS (Perfil + Estadísticas en paralelo) ---
        // Traemos el perfil y los conteos de una vez para evitar esperas en cascada
        const [perfilRes, comentariosRes, reportesRes] = await Promise.all([
            _db.from('perfiles').select('*').eq('nombre', nombreAMostrar).single(),
            _db.from('comentarios').select('id', { count: 'exact', head: true }).eq('usuario', nombreAMostrar),
            _db.from('reportes').select('id', { count: 'exact', head: true }).eq('usuario_reporta', nombreAMostrar)
        ]);

        if (perfilRes.error) throw perfilRes.error;
        const perfil = perfilRes.data;

        // --- 2. CÁLCULOS ---
        const totalVistos = (perfil.xp || 0) + ((perfil.nivel - 1) * 3);
        const horasTotales = Math.floor((totalVistos * 24) / 60);
        
        const fechaRegistro = new Date(perfil.fecha_registro);
        const aniosAntiguedad = (new Date() - fechaRegistro) / (1000 * 60 * 60 * 24 * 365.25);

        // --- 3. ACTUALIZACIÓN DE TEXTOS Y UI ---
        if (elementos.elUser) elementos.elUser.innerText = perfil.nombre;
        if (elementos.elLevel) elementos.elLevel.innerText = perfil.nivel;

        if (elementos.elRank) {
            const htmlRacha = typeof obtenerHtmlRacha === 'function' ? obtenerHtmlRacha(perfil.racha_dias) : "";
            elementos.elRank.innerHTML = htmlRacha || "ASPIRANTE";
        }

        if (elementos.elVistos) elementos.elVistos.innerText = totalVistos;
        if (elementos.elHoras) elementos.elHoras.innerText = `${horasTotales}h`;
        if (elementos.elFichas) elementos.elFichas.innerText = perfil.aidufichas || 0;
        if (elementos.elEdad) elementos.elEdad.innerText = perfil.edad || "--";

        // --- ACTUALIZACIÓN VISUAL DE LA BARRA DE XP ---
        if (elementos.elXPBar) {
            const porcentaje = ((perfil.xp || 0) / 3) * 100;
            elementos.elXPBar.style.width = `${porcentaje}%`;
        }
        if (elementos.elXPText) {
            elementos.elXPText.innerText = `${perfil.xp || 0}/3 XP`;
        }

        if (elementos.elBio) {
            elementos.elBio.innerText = perfil.bio 
                ? `"${perfil.bio}"` 
                : (esMismoUsuario ? "Toca aquí para añadir tu frase..." : "Sin descripción.");
        }

        // --- 4.5 GESTIÓN DE BOTONES DE AMISTAD ---
        const containerStats = document.querySelector('.profile-stats-row');
        const idBtnAmigo = 'btn-friend-action';
        if (document.getElementById(idBtnAmigo)) document.getElementById(idBtnAmigo).remove();

        if (!esMismoUsuario && containerStats) {
            const u1 = (currentUser || "").trim();
            const u2 = (nombreAMostrar || "").trim();

            // Consultar estado de amistad
            const { data: amistades } = await _db.from('amistades')
                .select('*')
                .or(`and(usuario_envia.eq."${u1}",usuario_recibe.eq."${u2}"),and(usuario_envia.eq."${u2}",usuario_recibe.eq."${u1}")`);

            const relacion = amistades && amistades.length > 0 ? amistades[0] : null;

            const btn = document.createElement('button');
            btn.id = idBtnAmigo;
            btn.className = 'btn-watch-party'; // Reutilizamos estilo

            if (!relacion) {
                btn.innerHTML = `➕ Agregar Amigo`;
                btn.onclick = () => enviarSolicitudAmistad(nombreAMostrar);
            } else if (relacion.estado === 'pendiente') {
                btn.innerHTML = relacion.usuario_envia === currentUser ? `⏳ Solicitud Enviada` : `✔️ Aceptar Amigo`;
                btn.style.opacity = relacion.usuario_envia === currentUser ? "0.6" : "1";
                if (relacion.usuario_recibe === currentUser) btn.onclick = () => gestionarSolicitud(relacion.id, 'aceptar', nombreAMostrar);
            } else {
                btn.innerHTML = `💬 Mensaje Privado`;
                btn.style.background = "linear-gradient(45deg, #ffd700, #ff8c00)";
                btn.style.color = "black";
                btn.onclick = () => cargarChatPrivado(nombreAMostrar);
            }
            containerStats.after(btn);
        }

        // Renderizar lista de amigos en perfil propio
        renderizarSeccionAmigos(perfil, esMismoUsuario);

        // --- 4. GESTIÓN DE AVATARES ---
        const avatarActualId = perfil.avatar_id || '1';
        // BUSQUEDA FUSIONADA: Buscamos en ambas listas
        const todosLosAvatares = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
        const avatarEncontrado = todosLosAvatares.find(av => av.id === String(avatarActualId));

        if (avatarEncontrado) {
            if (elementos.imgAvatar) elementos.imgAvatar.src = avatarEncontrado.img;
            // Actualizar miniatura de navegación solo si es el usuario logueado
            if (esMismoUsuario && elementos.navAvatar) {
                elementos.navAvatar.src = avatarEncontrado.img;
            }
        }
        
        // El selector solo aparece para el dueño
        if (esMismoUsuario) {
            renderAvatarSelector(perfil, avatarActualId);
        }

        // --- 5. LÓGICA DE CONDECORACIONES ---
        const condecoraciones = {
            nivel50: perfil.nivel >= 50,
            unAnio: aniosAntiguedad >= 1,
            justiciero: (comentariosRes.count || 0) >= 60 && (reportesRes.count || 0) >= 30,
             esPremium: perfil.es_premium,
            pionero: perfil.id <= 100,
            veterano3: aniosAntiguedad >= 3
        };

        renderCondecoraciones(condecoraciones);

    } catch (err) {
        console.error("Error al cargar el perfil de:", nombreAMostrar, err);
    }
}

function renderCondecoraciones(cond) {
    const container = document.querySelector('.badge-grid-pro');
    if (!container) return;
    container.innerHTML = ""; // Limpiar

    const lista = [
        { tiene: cond.nivel50, img: "1.png", title: "MEDALLA DEL DRAGÓN", txt: "Nivel 50 alcanzado", icon: "🐉" },
        { tiene: cond.unAnio, img: "2.png", title: "ESCUDO DE VALKYRIAS", txt: "1 año en AiduMe", icon: "🛡️" },
        { tiene: cond.justiciero, img: "3.png", title: "LEÓN DEL FUEGO", txt: "60 comentarios y 30 reportes válidos", icon: "🔥" },
        { tiene: cond.pionero, img: "4.png", title: "CRUZ DE HONOR", txt: "De los primeros 100 usuarios", icon: "🎖️" },
        { tiene: cond.esPremium, img: "5.png", title: "CORONA REAL", txt: "Miembro Premium de AiduMe", icon: "👑" },
        { tiene: cond.veterano3, img: "6.png", title: "ORBE ESTELAR", txt: "3 años de antigüedad", icon: "🌌" }
    ];

    lista.forEach(item => {
        if (item.tiene) {
            const el = document.createElement('img');
            el.src = `insignias/${item.img}`;
            el.className = "condecoracion-img";
            el.title = item.txt; 
            
            // --- REEMPLAZO DEL ALERT POR GOLD ALERT ---
            el.onclick = () => {
                goldAlert({
                    title: item.title,
                    text: item.txt,
                    icon: item.icon,
                    confirmText: "¡EXCELENTE!"
                });
            };
            
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
    
    // Si no hay datos, mostramos un mensaje de vacío
    container.innerHTML = data.length ? "" : "<p style='text-align:center; opacity:0.5; padding:20px;'>No hay resultados.</p>";
    
    data.forEach(a => {
        const div = document.createElement('div');
        div.className = 'card';
        div.onclick = () => showDetails(a);
        
        // 1. LÓGICA DE ETIQUETAS DE ESTADO (Airing/Finished/Upcoming)
        let etiquetaHTML = "";
        if (a.status === "Currently Airing") {
            etiquetaHTML = `<div class="status-tag emision">Emisión</div>`;
        } else if (a.status === "Finished Airing") {
            etiquetaHTML = `<div class="status-tag finalizado">Finalizado</div>`;
        } else if (a.status === "Not yet aired" || a.status === "Upcoming") {
            etiquetaHTML = `<div class="status-tag proximamente">Pronto</div>`;
        }

        // Badge para el número de episodio (Se activará automáticamente en la sección de Recientes)
        let epBadgeHTML = a.episode_number ? `<div class="ep-badge-float">EP ${a.episode_number}</div>` : "";

        // 2. TÍTULOS: Buscamos en español, si no, usamos el título principal
        const titleEs = a.titles ? a.titles.find(t => t.type === 'Spanish')?.title : null;
        const nombreMostrar = titleEs || a.title || "Sin título";

        // 3. IMÁGENES: Soporte para modo ahorro de datos (Data Saver)
        const imgUrl = (dataSaver && a.images?.jpg?.small_image_url) 
            ? a.images.jpg.small_image_url 
            : (a.images?.jpg?.image_url || 'placeholder.png');

        // 4. CONSTRUCCIÓN DEL HTML INTERNO
        div.innerHTML = `
            ${etiquetaHTML}
            ${epBadgeHTML}
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
            // Buscamos el avatar real usando el ID guardado localmente
            const todos = [...AVATARES_RANGOS, ...AVATARES_TIENDA];
            const av = todos.find(a => a.id === String(data.avatar_id || '1'));
            document.getElementById('nav-avatar').src = av ? av.img : `https://api.dicebear.com/7.x/avataaars/svg?seed=${data.name}`;
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

async function renderAvatarSelector(perfil, avatarActualId) {
    const grid = document.getElementById('avatar-selector-grid');
    if (!grid) return;
    grid.innerHTML = "";

    const comprados = perfil.avatares_comprados || [];
    const nivelUsuario = perfil.nivel;

    // Combinamos las listas para el selector
    const todos = [...AVATARES_RANGOS, ...AVATARES_TIENDA];

    todos.forEach(av => {
        // Un avatar es elegible si: es de nivel y tienes el nivel, O si está en la lista de comprados
        const esDeNivel = AVATARES_RANGOS.some(r => r.id === av.id);
        const esDesbloqueado = (esDeNivel && nivelUsuario >= av.minLvl) || comprados.includes(av.id);
        const esSeleccionado = avatarActualId === av.id;

        const img = document.createElement('img');
        img.src = av.img;
        img.className = `avatar-option ${esDesbloqueado ? 'unlocked' : 'locked'} ${esSeleccionado ? 'selected' : ''}`;
        img.style = `width:60px; height:60px; border-radius:50%; border: 2px solid ${esSeleccionado ? 'var(--gold)' : '#333'}; padding:2px; cursor:pointer; opacity:${esDesbloqueado ? '1' : '0.3'};`;
        
        if (esDesbloqueado) {
            img.onclick = () => cambiarAvatar(av.id, av.img);
        } else {
            img.onclick = () => goldAlert({ title: "BLOQUEADO", text: esDeNivel ? `Necesitas Nivel ${av.minLvl}` : "Debes comprar este avatar en la Tienda", icon: "🔒" });
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

        // Actualizamos el almacenamiento local para que al recargar se mantenga
        const data = JSON.parse(localStorage.getItem('aidume_profile'));
        if (data) {
            data.avatar_id = id;
            localStorage.setItem('aidume_profile', JSON.stringify(data));
        }

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
    const videoContainer = document.getElementById('video-player-container');

    // --- MEJORA: RECARGA NUCLEAR SI EL VIDEO ESTÁ ACTIVO ---
    // Si el usuario cierra la ficha mientras un video suena, recargamos la página 
    // para asegurar que el audio se detenga por completo, igual que la barra inferior.
    const iframeActivo = videoContainer ? videoContainer.querySelector('iframe') : null;
    if (iframeActivo && videoContainer.style.display !== "none" && iframeActivo.src !== "" && !iframeActivo.src.includes("about:blank")) {
        // Detectamos qué página está activa actualmente para regresar a ella tras recargar
        const activePage = document.querySelector('.page.active-page');
        if (activePage) {
            window.location.hash = activePage.id;
        }
        window.location.reload();
        return; // Salimos aquí, la recarga se encarga del resto
    }

    const videoInfo = document.getElementById('video-ep-title');

    // 1. Ocultar el panel visual
    if (details) details.style.display = "none";
    
    // 2. DESTRUCCIÓN TOTAL DEL REPRODUCTOR
    if (videoContainer) {
        // Buscamos todos los iframes (por si quedó más de uno)
        const iframes = videoContainer.querySelectorAll('iframe');
        
        iframes.forEach(iframe => {
            // Paso A: Cortar la comunicación con el servidor de video
            iframe.src = "about:blank"; 
            
            // Paso B: Limpiar el contenido interno (si el navegador lo permite)
            try {
                iframe.contentWindow.document.write('');
                iframe.contentWindow.close();
            } catch (e) {
                // Silenciamos errores de seguridad (Cross-Origin)
            }

            // Paso C: Eliminarlo físicamente del DOM
            iframe.remove();
        });

        // Paso D: Vaciar el contenedor y forzar su desaparición
        //videoContainer.innerHTML = ""; 
        videoContainer.style.display = "none";
    }

    // 3. Limpieza de interfaz
    if (videoInfo) videoInfo.innerText = "";

    // 4. TRUCO FINAL: Forzar el foco fuera de cualquier elemento multimedia
    // Esto le dice al sistema operativo (Android/iOS) que la web ya no está "reproduciendo"
    const tmp = document.createElement('input');
    document.body.appendChild(tmp);
    tmp.focus();
    document.body.removeChild(tmp);
}

/**
 * Inicia el proceso de transmisión a Smart TV
 */
async function transmitirTV() {
    if (!urlTransmisionActual) return;

    const confirmar = await goldAlert({
        title: "TRANSMITIR A TV",
        text: "Para ver en tu TV:\n1. Asegúrate de estar en la misma red WiFi.\n2. Presiona 'EMPEZAR' y busca el icono de Cast/Pantalla en el video o en tu navegador.",
        icon: "📺",
        showCancel: true,
        confirmText: "EMPEZAR"
    });

    if (confirmar) {
        // Abrimos la URL en una pestaña limpia para que el navegador 
        // habilite las herramientas de Cast/AirPlay nativas.
        const win = window.open(urlTransmisionActual, '_blank');
        if (!win) {
            goldAlert({ title: "BLOQUEADO", text: "Tu navegador bloqueó la ventana emergente. Permítela para transmitir.", icon: "🚫" });
        }
    }
}

async function verPerfilAjeno(nombreUsuario) {
    // 1. Ocultamos el chat para ver el perfil
    const win = document.getElementById('chat-window');
    if (win) win.style.display = 'none';

    // 2. ¡FUNDAMENTAL!: Cerramos la vista de detalles del anime.
    // Esto elimina el overlay que bloqueaba la visibilidad del perfil.
    hideDetails();

    // 3. Cambiamos a la pestaña de perfil manualmente
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page'));
    const perfilPage = document.getElementById('perfil');
    if (perfilPage) perfilPage.classList.add('active-page');

    // 4. Actualizamos el estado visual de los botones de navegación (Dorado)
    document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.remove('active');
        const clickAction = n.getAttribute('onclick') || "";
        if (clickAction.includes("'perfil'") || clickAction.includes('"perfil"')) {
            n.classList.add('active');
        }
    });

    // 5. Aseguramos que el scroll suba al inicio del perfil
    window.scrollTo(0, 0);

    // 6. Llamamos a la carga con el nombre del otro usuario
    actualizarPerfilDesdeSQL(nombreUsuario);
}

// Único disparador al cargar la web
window.addEventListener('load', checkUser);

// --- SISTEMA DE EMOJIS ---
let activeEmojiInputId = null;

function toggleEmojiPicker(inputId, btn) {
    let picker = document.getElementById('global-emoji-picker');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'global-emoji-picker';
        picker.className = 'emoji-picker-popup';
        picker.style.display = 'none';
        const emojis = ["😊","😂","🤣","😍","🤔","🙄","😒","😭","😩","😎","🔥","✨","👑","💯","👏","🙏","👍","👎","💬","❤️","💔","🎌","🇯🇵","📺","🍿","⭐"];
        picker.innerHTML = emojis.map(e => `<span class="emoji-item" onclick="insertEmoji('${e}')">${e}</span>`).join('');
        document.body.appendChild(picker);
        
        document.addEventListener('mousedown', (e) => {
            if (picker.style.display === 'grid' && !picker.contains(e.target) && !e.target.closest('.emoji-trigger')) {
                picker.style.display = 'none';
            }
        });
    }

    // Al abrir emojis, cerramos stickers si estuvieran abiertos
    const stickerPicker = document.getElementById('global-sticker-picker');
    if (stickerPicker) stickerPicker.style.display = 'none';

    if (picker.style.display === 'grid' && activeEmojiInputId === inputId) {
        picker.style.display = 'none';
    } else {
        activeEmojiInputId = inputId;
        const rect = btn.getBoundingClientRect();
        picker.style.left = `${Math.max(10, Math.min(window.innerWidth - 250, rect.left - 100))}px`;
        picker.style.top = `${rect.top - 210}px`; // Posición sobre el botón
        picker.style.display = 'grid';
    }
}

function insertEmoji(emoji) {
    const input = document.getElementById(activeEmojiInputId);
    if (input) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
        input.focus();
        input.setSelectionRange(start + emoji.length, start + emoji.length);
    }
    document.getElementById('global-emoji-picker').style.display = 'none';
}

// --- SISTEMA DE STICKERS ---
async function toggleStickerPicker(inputId, btn) {
    let picker = document.getElementById('global-sticker-picker');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'global-sticker-picker';
        picker.className = 'sticker-picker-popup';
        picker.style.display = 'none';
        picker.innerHTML = `<div class="sticker-tabs" id="stk-tabs"></div><div class="sticker-grid-content" id="stk-grid"></div>`;
        document.body.appendChild(picker);

        document.addEventListener('mousedown', (e) => {
            if (picker.style.display === 'flex' && !picker.contains(e.target) && !e.target.closest('.emoji-trigger')) {
                picker.style.display = 'none';
            }
        });
    }

    // Al abrir stickers, cerramos emojis si estuvieran abiertos
    const emojiPicker = document.getElementById('global-emoji-picker');
    if (emojiPicker) emojiPicker.style.display = 'none';

    if (picker.style.display === 'flex' && activeEmojiInputId === inputId) {
        picker.style.display = 'none';
    } else {
        activeEmojiInputId = inputId;

        // Consultamos los packs desbloqueados del usuario
        const { data: perfil } = await _db.from('perfiles').select('stickers_comprados').eq('nombre', currentUser).single();
        const comprados = perfil?.stickers_comprados || [];

        // El Pack 1 (1-10) es gratis y siempre visible
        const packsVisibles = [
            { id: 'stk_pack_1', nombre: 'Básico', inicio: 1, fin: 10 },
            ...STICKER_PACKS_TIENDA.filter(p => comprados.includes(p.id))
        ];

        const tabs = document.getElementById('stk-tabs');
        tabs.innerHTML = packsVisibles.map((p, i) => 
            `<span class="sticker-tab ${i === 0 ? 'active' : ''}" onclick="cargarPackEnPicker(${p.inicio}, ${p.fin}, this)">${p.nombre}</span>`
        ).join('');

        // Cargamos el primer pack por defecto
        cargarPackEnPicker(packsVisibles[0].inicio, packsVisibles[0].fin, tabs.firstChild);

        const rect = btn.getBoundingClientRect();
        picker.style.left = `${Math.max(10, Math.min(window.innerWidth - 260, rect.left - 120))}px`;
        picker.style.top = `${rect.top - 310}px`;
        picker.style.display = 'flex';
    }
}

function cargarPackEnPicker(inicio, fin, btnTab) {
    // Gestionar estado activo de pestañas
    document.querySelectorAll('.sticker-tab').forEach(t => t.classList.remove('active'));
    btnTab.classList.add('active');

    const grid = document.getElementById('stk-grid');
    let html = "";
    for (let i = inicio; i <= fin; i++) {
        const url = `stickers/${i}.gif`;
        html += `<img src="${url}" class="sticker-item" onclick="insertSticker('${url}')">`;
    }
    grid.innerHTML = html;
}

function insertSticker(url) {
    const input = document.getElementById(activeEmojiInputId);
    if (input) {
        input.value = `[STK:${url}]`;
        const container = input.parentElement;
        const sendBtn = container.querySelector('button[onclick*="enviar"], button[onclick*="postear"]');
        if (sendBtn) sendBtn.click();
    }
    document.getElementById('global-sticker-picker').style.display = 'none';
}