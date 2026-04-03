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
    const mainBtn = document.getElementById('main-auth-btn');
    const switchLink = document.getElementById('auth-switch');

    if (isRegisterMode) {
        ageField.style.display = "block";
        mainBtn.innerText = "CREAR CUENTA";
        switchLink.innerHTML = '¿Ya tienes cuenta? <span onclick="toggleAuthMode()">Inicia sesión</span>';
    } else {
        ageField.style.display = "none";
        mainBtn.innerText = "ENTRAR";
        switchLink.innerHTML = '¿No tienes cuenta? <span onclick="toggleAuthMode()">Regístrate aquí</span>';
    }
}

async function ejecutarAuth() {
    const user = document.getElementById('reg-user').value.trim();
    const pass = document.getElementById('reg-pass').value.trim();
    const age = document.getElementById('reg-age').value;

    if (!user || !pass) return alert("Usuario y contraseña obligatorios");

    try {
        if (isRegisterMode) {
            // --- MODO REGISTRO ---
            if (!age) return alert("Por favor indica tu edad");

            // 1. AVISO DE NORMAS OBLIGATORIO (NUEVO)
            const aceptaNormas = confirm(
                "¡Bienvenido a AiduMe!\n\n" +
                "Antes de crear tu cuenta, acepta nuestras normas:\n" +
                "1. Respeto total a los demás fans (sin insultos).\n" +
                "2. No spoilers sin avisar.\n" +
                "3. El uso indebido de reportes causará el baneo de TU cuenta.\n" +
                "4. Las decisiones de Admins y el Dueño son inapelables.\n\n" +
                "¿Aceptas cumplir el reglamento de la comunidad?"
            );

            if (!aceptaNormas) return alert("Debes aceptar las normas para unirte a AiduMe.");

            // 2. REGISTRO EN SUPABASE
            const { data, error } = await _db
                .from('perfiles')
                .insert([{ 
                    nombre: user, 
                    password: pass, 
                    edad: parseInt(age),
                    rol: 'user' // Por seguridad, siempre inicia como user
                }])
                .select()
                .single();

            if (error) {
                if (error.code === "23505") alert("El nombre de usuario ya está en uso");
                else throw error;
            } else {
                alert("¡Cuenta creada con éxito! Bienvenido a la comunidad.");
                finalizarLogin(data);
            }

        } else {
            // --- MODO LOGIN ---
            const { data: perfil, error } = await _db
                .from('perfiles')
                .select('*')
                .eq('nombre', user)
                .eq('password', pass)
                .maybeSingle();

            if (error) throw error;
            if (!perfil) return alert("Usuario o contraseña incorrectos");

            // --- VERIFICACIÓN DE BANEO ---
            if (perfil.baneado_hasta) {
                const ahora = new Date();
                const finBaneo = new Date(perfil.baneado_hasta);
                
                if (ahora < finBaneo) {
                    return alert(`⛔ ACCESO DENEGADO\n\nEstás suspendido por infringir las normas.\nFin de la sanción: ${finBaneo.toLocaleString()}`);
                }
            }

            finalizarLogin(perfil);
        }
    } catch (err) {
        console.error("Error en el proceso de autenticación:", err.message);
        alert("Ocurrió un error inesperado. Inténtalo de nuevo.");
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

// Llamar a la función al cargar la web
window.addEventListener('load', solicitarPermisoNotificaciones);