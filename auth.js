// 1. CONFIGURACIÓN: Cambiamos el nombre a '_db' para que no choque
const _supabaseUrl = 'https://qapzqknunzfajeuowowm.supabase.co'; 
const _supabaseKey = 'sb_publishable_EpH2t8ga7gJKXWCVcMK7gA_TmbEpjzc';

// IMPORTANTE: Aquí usamos 'supabase.createClient' (la librería) 
// para crear nuestra variable '_db'
const _db = supabase.createClient(_supabaseUrl, _supabaseKey);

let currentUser = null;
let isRegisterMode = false;

function toggleAuthMode() {
    isRegisterMode = !isRegisterMode;
    const ageField = document.getElementById('reg-age');
    const emailField = document.getElementById('reg-email'); //
    const captchaCont = document.getElementById('captcha-container'); //
    const notifCont = document.getElementById('notif-req-container');
    const mainBtn = document.getElementById('main-auth-btn');
    const switchLink = document.getElementById('auth-switch');

    if (isRegisterMode) {
        ageField.style.display = "block";
        emailField.style.display = "block"; // Se vuelve visible
        captchaCont.style.display = "block"; // Se vuelve visible
        notifCont.style.display = "block";
        generarCaptcha();
        mainBtn.innerText = "CREAR CUENTA";
        switchLink.innerHTML = '¿Ya tienes cuenta? <span onclick="toggleAuthMode()" style="text-decoration: underline;">Inicia sesión</span>';
    } else {
        ageField.style.display = "none";
        emailField.style.display = "none"; // Se oculta en login
        captchaCont.style.display = "none"; // Se oculta en login
        notifCont.style.display = "none";
        mainBtn.innerText = "ENTRAR";
        switchLink.innerHTML = '¿No tienes cuenta? <span onclick="toggleAuthMode()" style="text-decoration: underline;">Regístrate aquí</span>';
    }
}

async function ejecutarAuth() {
    const user = document.getElementById('reg-user').value.trim();
    const pass = document.getElementById('reg-pass').value.trim();

    // Validamos campos base con modal propio
    if (!user || !pass) return mostrarAlerta("Usuario y contraseña obligatorios");

    try {
        if (isRegisterMode) {
            // --- MODO REGISTRO (SEGURIDAD DE ORO) ---
            const email = document.getElementById('reg-email')?.value.trim();
            const age = document.getElementById('reg-age').value;
            const captchaInput = document.getElementById('reg-captcha-input')?.value.trim().toUpperCase();
            const notifCheck = document.getElementById('reg-notif-check').checked;

            // 1. Validaciones básicas
            if (!email || !age) return mostrarAlerta("Todos los campos (incluyendo Email y Edad) son obligatorios");
            
            if (!notifCheck) {
                return goldAlert({
                    title: "RADAR DESACTIVADO",
                    text: "Para unirte a la experiencia Gold de AiduMe, es obligatorio aceptar el radar de notificaciones.",
                    icon: "📡"
                });
            }

            // 2. Validación de Captcha
            if (captchaInput !== captchaActual) {
                mostrarAlerta("Código Captcha incorrecto. Inténtalo de nuevo.");
                generarCaptcha();
                return;
            }

            // 🛑 NUEVO: Solicitar permiso de notificaciones AQUÍ, directamente en el gesto del usuario
            // (antes de cualquier async/await o modal) para que funcione en móvil.
            if ("Notification" in window && Notification.permission === "default") {
                Notification.requestPermission();
            }

            // 3. Apertura del Reglamento de Oro (Sustituye al confirm)
            // Nota: El botón "ACEPTO" de este modal debe llamar a aceptarNormasRegistro()
            abrirNormasRegistro();

        } else {
            // --- MODO LOGIN ---
            const { data: perfil, error } = await _db
                .from('perfiles')
                .select('*')
                .ilike('nombre', user)
                .eq('password', pass)
                .maybeSingle();

            if (error) throw error;
            if (!perfil) return mostrarAlerta("Usuario o contraseña incorrectos");

            // 4. Verificación de Baneo
            if (perfil.baneado_hasta) {
                const ahora = new Date();
                const finBaneo = new Date(perfil.baneado_hasta);
                
                if (ahora < finBaneo) {
                    return mostrarAlerta(`⛔ ACCESO DENEGADO\n\nEstás suspendido.\nFin de la sanción: ${finBaneo.toLocaleString()}`);
                }
            }

            finalizarLogin(perfil);
        }
    } catch (err) {
        console.error("Error en Auth:", err.message);
        mostrarAlerta("Error inesperado: " + err.message);
    }
}

// Lógica final de inserción tras aceptar normas en el modal
async function procederConRegistro() {
    const user = document.getElementById('reg-user').value.trim();
    const pass = document.getElementById('reg-pass').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const age = document.getElementById('reg-age').value;

    try {
        // --- VALIDACIÓN DE ACCESO GOLD (NOTIFICACIONES) ---
        // Ya pedimos permiso al inicio del registro (en ejecutarAuth para móvil).
        // Aquí solo verificamos el estado actual sin intentar pedirlo de nuevo
        // (en móvil, una segunda llamada fuera del gesto del usuario fallaría).
        const permission = Notification.permission;
        if (permission !== 'granted') {
            // Si aún está "default", intentamos pedirlo ahora (último recurso)
            if (permission === "default") {
                const result = await Notification.requestPermission();
                if (result !== 'granted') {
                    await goldAlert({
                        title: "ACCESO RESTRINGIDO",
                        text: "No podemos otorgarte el rango de usuario si el radar de notificaciones está bloqueado. La aplicación se reiniciará para proteger el sistema.",
                        icon: "🔐"
                    });
                    location.reload();
                    return;
                }
            } else {
                await goldAlert({
                    title: "ACCESO RESTRINGIDO",
                    text: "No podemos otorgarte el rango de usuario si el radar de notificaciones está bloqueado. La aplicación se reiniciará para proteger el sistema.",
                    icon: "🔐"
                });
                location.reload();
                return;
            }
        }

        // 5. Control de IP (Máximo 2 cuentas)
        const userIP = await obtenerIP();
        const { count, error: ipError } = await _db
            .from('perfiles')
            .select('*', { count: 'exact', head: true })
            .eq('registro_ip', userIP);

        if (ipError) throw ipError;
        if (count >= 2) return mostrarAlerta("⚠️ Límite de seguridad: Solo se permiten 2 cuentas por conexión.");

        // 6. Registro Final en Supabase
        const { data, error } = await _db
            .from('perfiles')
            .insert([{ 
                nombre: user, 
                password: pass, 
                email: email,
                edad: parseInt(age),
                registro_ip: userIP,
                rol: 'user' 
            }])
            .select().single();

        if (error) {
            if (error.code === "23505") mostrarAlerta("El nombre de usuario o el email ya están registrados.");
            else throw error;
        } else {
            mostrarAlerta("¡Cuenta creada con éxito! Bienvenido a AiduMe.", "✨ BIENVENIDO");
            setTimeout(() => finalizarLogin(data), 2000);
        }
    } catch (err) {
        mostrarAlerta("Error al registrar: " + err.message);
    }
}

// En auth.js, busca finalizarLogin y agrega la línea al final
function finalizarLogin(perfil) {
    // Guardamos los datos en el almacenamiento local
    localStorage.setItem('aidume_profile', JSON.stringify({ 
        name: perfil.nombre, 
        age: perfil.edad,
        rol: perfil.rol || 'user',
        premium: perfil.es_premium || false,
        avatar_id: perfil.avatar_id || '1',
        ultimo_visto_chat: perfil.ultimo_visto_chat
    }));
    
    // Mostramos el icono de chat antes de cualquier otra acción
    const chatBubble = document.getElementById('chat-bubble');
    const hideChat = localStorage.getItem('hide_chat') === 'true';
    if (chatBubble && !hideChat) {
        chatBubble.style.display = 'flex';
    }

    // Pedimos permiso de notificaciones
    solicitarPermisoNotificaciones(); 

    // Al recargar la página, el sistema debe leer el localStorage para mantenerlo visible
    location.reload();
}

function checkUser() {
    // ... todo este bloque fuera ...
}
window.onload = checkUser;

function cerrarSesion() {
    async function ejecutarCierre() {
        const confirmar = await goldAlert({
            title: "CERRAR SESIÓN",
            text: "¿Estás seguro de que deseas salir?",
            icon: "🚪",
            showCancel: true,
            confirmText: "SÍ, SALIR"
        });

        if (confirmar) {
            // Marcamos como offline en la base de datos antes de limpiar el local
            if (currentUser) {
                await _db.from('perfiles').update({ online: false }).ilike('nombre', currentUser);
            }

        localStorage.clear();
        const chatBubble = document.getElementById('chat-bubble');
        if (chatBubble) chatBubble.style.display = 'none';
        location.reload();
        }
    }
    ejecutarCierre();
}

// Agrega esto al final de auth.js o ui.js
function solicitarPermisoNotificaciones() {
    if (!("Notification" in window)) {
        console.log("Este navegador no soporta notificaciones de escritorio.");
        return;
    }

    Notification.requestPermission().then(permission => {
        if (permission === "granted" && 'serviceWorker' in navigator) {
            navigator.serviceWorker.register('sw.js').then(() => {
                console.log("Service Worker de Oro registrado.");
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const captchaRefreshBtn = document.getElementById('captcha-refresh-btn');
    if (captchaRefreshBtn) {
        captchaRefreshBtn.addEventListener('click', generarCaptcha);
    }

    // Soporte para Enter en los campos de usuario y contraseña
    ['reg-user', 'reg-pass', 'reg-email', 'reg-age', 'reg-captcha-input'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') ejecutarAuth();
            });
        }
    });
});

let captchaActual = "";

// Genera un código aleatorio para el captcha
function generarCaptcha() {
    const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    captchaActual = "";
    for (let i = 0; i < 5; i++) {
        captchaActual += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    const elem = document.getElementById('captcha-text');
    if (elem) elem.innerText = captchaActual;
}

// Obtiene la IP del usuario usando un servicio gratuito
async function obtenerIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip;
    } catch (e) { return "127.0.0.1"; }
}

// Configuración
const CONFIG_ADS = {
    url: "https://www.profitablecpmratenetwork.com/ps9ru812?key=d28fbdf372a7cab7448a65e46cd2b188", 
    clicsNecesarios: 1, 
    tiempoEspera: 60000 // O esperar 1 minuto entre anuncios (en milisegundos)
};

function lanzarAnuncio() {
    const perfil = JSON.parse(localStorage.getItem('aidume_profile'));
    
    // --- FILTRO DE ORO: SI ES PREMIUM, NO HAY ANUNCIOS ---
    if (perfil && perfil.premium) {
        console.log("💎 Usuario Premium detectado: Disfrutando sin anuncios.");
        return;
    }

    // Obtenemos el contador actual del almacenamiento de sesión
    let clics = parseInt(sessionStorage.getItem('conteoAnuncio')) || 0;
    clics++;

    if (clics >= CONFIG_ADS.clicsNecesarios) {
        // Intentamos abrir el anuncio. Guardamos la referencia para verificar.
        const adWindow = window.open(CONFIG_ADS.url, '_blank');
        
        if (!adWindow || adWindow.closed || typeof adWindow.closed === 'undefined') {
            console.warn("⚠️ El anuncio de Oro fue bloqueado por el navegador o un AdBlocker.");
        } else {
            console.log("💰 Anuncio de Oro lanzado. Esperando registro de Adsterra...");
        }

        // Reiniciamos el contador
        sessionStorage.setItem('conteoAnuncio', '0');
    } else {
        // Guardamos el nuevo conteo
        sessionStorage.setItem('conteoAnuncio', clics.toString());
    }
}

// Llamar a la función al cargar la web
window.addEventListener('load', solicitarPermisoNotificaciones);

// Detección de TV/Android TV para ocultar el chat automáticamente
function esDispositivoTV() {
    const ua = navigator.userAgent || navigator.vendor || window.opera || '';
    
    // Detecta Android TV, Google TV, Apple TV, Smart TV, consolas y dispositivos TV-box
    const patronesTV = [
        /Android.*TV/i,
        /Google TV/i,
        /Smart.?TV/i,
        /AppleTV/i,
        /Tizen/i,
        /Web0?[sS]/i,       // Samsung TV / WebOS
        /NetCast/i,          // LG TV
        /Kylo/i,             // Firefox TV (Amazon Fire TV)
        /AFT[TBMRS]/i,       // Amazon Fire TV (AFTT, AFTB, AFTR, AFTM, etc.)
        /PlayStation/i,
        /Xbox/i,
        /Nintendo/i,
        /BRAVIA/i,           // Sony Bravia
        /Roku/i,
        /Vizio/i,
        /navigator\.tv/i,    // Opera TV
        /DTV/i,              // Digital TV
        /HbbTV/i,            // Hybrid Broadcast Broadband TV
        /TV\s?[0-9]/i,
        /Large Screen/i,
        /PHILIPS/i,
        /Panasonic/i,
        /SHARP/i,
        /HISENSE/i,
        /TCL/i
    ];

    // También detectamos por tamaño de pantalla: si es > 50" típicamente es TV
    // Y detectamos si NO tiene soporte táctil (típico en TVs)
    const esPantallaGrande = window.screen && (
        (window.screen.width >= 1280 && !('ontouchstart' in window) && !navigator.maxTouchPoints) ||
        (window.screen.availWidth >= 1920 && navigator.maxTouchPoints <= 1)
    );

    // Detectar modo TV en navegadores: userAgentMode o la propiedad 'displayMode'
    const esTVMode = window.matchMedia && (
        window.matchMedia('(display-mode: standalone)').matches === false && // No es PWA
        esPantallaGrande &&
        ua.toLowerCase().includes('brave') === false && // No confundir Brave desktop con TV
        ua.toLowerCase().includes('chrome') === false && // Evitar falsos positivos en PC con Chrome en 1920px
        !navigator.userAgentData?.mobile &&
        !navigator.userAgentData?.formFactor?.includes('desktop')
    );

    return patronesTV.some(p => p.test(ua)) || esTVMode;
}

// ===== SISTEMA DE ACCESO RÁPIDO PARA TV =====

/**
 * Genera un código PIN de 6 dígitos aleatorio
 */
function generarPinTv() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * La TV genera un código y empieza a esperar que lo vinculen
 */
async function iniciarSesionTV() {
    // Si ya hay sesión guardada, la usamos
    const tvSession = localStorage.getItem('aidume_tv_session');
    if (tvSession) {
        const session = JSON.parse(tvSession);
        if (session && session.usuario) {
            console.log("📺 Sesión TV recuperada para:", session.usuario);
            // Simulamos un login normal
            currentUser = session.usuario;
            localStorage.setItem('aidume_profile', JSON.stringify(session.usuario_data));
            const overlay = document.getElementById('auth-overlay');
            if (overlay) overlay.style.display = 'none';
            if (typeof initApp === 'function') initApp();
            return;
        }
    }

    // Generar código
    const codigo = generarPinTv();
    const expiracion = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min

    try {
        const { error } = await _db.from('tv_access_codes').insert([{
            codigo: codigo,
            expiracion: expiracion
        }]);

        if (error) throw error;

        // Mostrar código en pantalla grande
        const overlay = document.getElementById('auth-overlay');
        if (overlay) {
            overlay.innerHTML = `
                <div class="auth-card tv-auth-card" style="max-width:380px;">
                    <img src="logo-grande.png" alt="Logo" style="width:120px; margin-bottom:15px;">
                    <h2 style="color:var(--gold); margin-bottom:10px; font-size:1.1rem;">📡 ACCEDE DESDE TU CELULAR</h2>
                    <p style="color:#aaa; font-size:0.8rem; margin-bottom:20px;">
                        Abre <strong>AiduMe</strong> en tu celular, ve a tu perfil y toca el botón <strong>"📡 Vincular TV"</strong>. Ingresa este código:
                    </p>
                    <div class="tv-pin-display" style="
                        background: linear-gradient(135deg, #1a1a1a, #0d0d0d);
                        border: 3px solid var(--gold);
                        border-radius: 20px;
                        padding: 25px 20px;
                        margin: 15px auto;
                        width: fit-content;
                        min-width: 220px;
                        box-shadow: 0 0 40px rgba(255, 215, 0, 0.2), inset 0 0 20px rgba(255, 215, 0, 0.05);
                    ">
                        <div style="font-size:3.2rem; font-weight:900; letter-spacing:12px; color:var(--gold); font-family:monospace; text-shadow: 0 0 20px rgba(255,215,0,0.3);" id="tv-pin-code">
                            ${codigo}
                        </div>
                    </div>
                    <p style="color:#666; font-size:0.7rem; margin-top:15px;">
                        ⏳ El código expira en <span id="tv-countdown" style="color:var(--gold); font-weight:bold;">5:00</span> min
                    </p>
                    <button onclick="cancelarSesionTV()" class="btn-random-gold" style="margin-top:10px; width:100%; border-color:#ff4444; color:#ff4444;">
                        CANCELAR
                    </button>
                </div>`;
            overlay.style.display = 'flex';
        }

        // Contador regresivo
        let segundosRestantes = 300;
        let codigoActivo = codigo;

        const intervaloContador = setInterval(() => {
            segundosRestantes--;
            const mins = Math.floor(segundosRestantes / 60);
            const segs = segundosRestantes % 60;
            const display = document.getElementById('tv-countdown');
            if (display) display.innerText = `${mins}:${segs.toString().padStart(2, '0')}`;

            if (segundosRestantes <= 0) {
                clearInterval(intervaloContador);
                if (window.tvPollingInterval) clearInterval(window.tvPollingInterval);
                // Eliminar código expirado
                _db.from('tv_access_codes').delete().eq('codigo', codigoActivo).then(() => {});
                const overlay = document.getElementById('auth-overlay');
                if (overlay) {
                    overlay.innerHTML = `
                        <div class="auth-card" style="text-align:center;">
                            <p style="color:#ff4444; font-size:1rem;">⏰ Código expirado</p>
                            <button onclick="location.reload()" class="btn-random-gold" style="margin-top:15px;">INTENTAR DE NUEVO</button>
                        </div>`;
                }
            }
        }, 1000);

        // Cada 3 segundos verificar si el código fue reclamado
        window.tvPollingInterval = setInterval(async () => {
            const { data, error } = await _db.from('tv_access_codes')
                .select('usuario, usuario_data, reclamado')
                .eq('codigo', codigoActivo)
                .single();

            if (error) return;

            if (data && data.reclamado && data.usuario && data.usuario_data) {
                // Código reclamado! Iniciar sesión
                clearInterval(intervaloContador);
                if (window.tvPollingInterval) {
                    clearInterval(window.tvPollingInterval);
                    window.tvPollingInterval = null;
                }

                // Guardar sesión en TV
                localStorage.setItem('aidume_tv_session', JSON.stringify({
                    usuario: data.usuario,
                    usuario_data: data.usuario_data
                }));

                // Simular login
                const perfilData = typeof data.usuario_data === 'string' 
                    ? JSON.parse(data.usuario_data) 
                    : data.usuario_data;

                currentUser = perfilData.name || data.usuario;
                localStorage.setItem('aidume_profile', JSON.stringify(perfilData));

                // Cerrar overlay y arrancar app
                const overlay = document.getElementById('auth-overlay');
                if (overlay) overlay.style.display = 'none';

                goldAlert({
                    title: "📡 TV VINCULADA",
                    text: `Bienvenido @${data.usuario}. Sesión iniciada desde el celular.`,
                    icon: "✅"
                });

                if (typeof initApp === 'function') initApp();
            }
        }, 3000);

    } catch (err) {
        console.error("Error al generar código TV:", err);
        const overlay = document.getElementById('auth-overlay');
        if (overlay) {
            overlay.innerHTML = `
                <div class="auth-card" style="text-align:center;">
                    <p style="color:#ff4444;">Error de conexión. Intenta de nuevo.</p>
                    <button onclick="location.reload()" class="btn-random-gold" style="margin-top:15px;">REINTENTAR</button>
                </div>`;
        }
    }
}

/**
 * Cancela la sesión de TV en curso
 */
function cancelarSesionTV() {
    if (window.tvPollingInterval) {
        clearInterval(window.tvPollingInterval);
        window.tvPollingInterval = null;
    }
    location.reload();
}

/**
 * Cierra la sesión de TV (borra la sesión guardada)
 */
function cerrarSesionTV() {
    localStorage.removeItem('aidume_tv_session');
    location.reload();
}

// Si se detecta TV, ocultar el chat y mostrar login rápido
if (esDispositivoTV()) {
    localStorage.setItem('hide_chat', 'true');
    console.log("📺 Dispositivo TV detectado: Chat oculto automáticamente.");

    // Agregar clase tv-device al body para que el CSS pueda adaptarse
    document.documentElement.classList.add('tv-device');

    // En vez del login normal, mostrar el sistema de código PIN
    window.addEventListener('load', () => {
        const perfil = localStorage.getItem('aidume_profile');
        if (!perfil) {
            // No hay sesión, iniciar flujo TV
            setTimeout(() => iniciarSesionTV(), 500);
        }
    });
}

window.addEventListener('load', () => {
    const perfilGuardado = localStorage.getItem('aidume_profile');
    const chatBubble = document.getElementById('chat-bubble');
    const hideChat = localStorage.getItem('hide_chat') === 'true';
    
    if (perfilGuardado && chatBubble && !hideChat) {
        chatBubble.style.display = 'flex';
    } else if (chatBubble) {
        chatBubble.style.display = 'none';
    }
});
