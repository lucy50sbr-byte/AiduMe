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
    const mainBtn = document.getElementById('main-auth-btn');

    if (isRegisterMode) {
        ageField.style.display = "block";
        emailField.style.display = "block"; // Se vuelve visible
        captchaCont.style.display = "block"; // Se vuelve visible
        generarCaptcha();
        mainBtn.innerText = "CREAR CUENTA";
    } else {
        ageField.style.display = "none";
        emailField.style.display = "none"; // Se oculta en login
        captchaCont.style.display = "none"; // Se oculta en login
        mainBtn.innerText = "ENTRAR";
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

            // 1. Validaciones básicas
            if (!email || !age) return mostrarAlerta("Todos los campos (incluyendo Email y Edad) son obligatorios");
            
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
                .eq('nombre', user)
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
    localStorage.setItem('aidume_profile', JSON.stringify({ 
        name: perfil.nombre, 
        age: perfil.edad,
        rol: perfil.rol || 'user'
    }));
    
    // Solo pedimos permiso si el login fue exitoso
    solicitarPermisoNotificaciones(); 

    location.reload();
}

function checkUser() {
    // ... todo este bloque fuera ...
}
window.onload = checkUser;

function cerrarSesion() {
    if(confirm("¿Cerrar sesión?")) {
        localStorage.clear();
        location.reload();
    }
}

// Agrega esto al final de auth.js o ui.js
function solicitarPermisoNotificaciones() {
    if (!("Notification" in window)) {
        console.log("Este navegador no soporta notificaciones de escritorio.");
        return;
    }

    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                console.log("¡Permiso de notificaciones concedido!");
            }
        });
    }
}

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

// Llamar a la función al cargar la web
window.addEventListener('load', solicitarPermisoNotificaciones);