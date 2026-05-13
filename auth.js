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
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            await goldAlert({
                title: "ACCESO RESTRINGIDO",
                text: "No podemos otorgarte el rango de usuario si el radar de notificaciones está bloqueado. La aplicación se reiniciará para proteger el sistema.",
                icon: "🔐"
            });
            location.reload();
            return;
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
    if (chatBubble) {
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

window.addEventListener('load', () => {
    const perfilGuardado = localStorage.getItem('aidume_profile');
    const chatBubble = document.getElementById('chat-bubble');
    
    if (perfilGuardado && chatBubble) {
        chatBubble.style.display = 'flex';
    } else if (chatBubble) {
        chatBubble.style.display = 'none';
    }
});