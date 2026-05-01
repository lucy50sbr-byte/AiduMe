import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Manejo de preflight requests (CORS)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Solo permitimos solicitudes POST para procesar pagos
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ message: 'Método no permitido. Solo POST.' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body: { usuario: string; metodo: string; email?: string; dni?: string; token?: string; payment_method_id?: string; installments?: number; issuer_id?: string; monto?: number; referencia?: string; } = await req.json();
    const { usuario, metodo, email, dni, token, payment_method_id, installments, issuer_id, monto, referencia } = body;

    if (!usuario) {
      return new Response(JSON.stringify({ message: 'Faltan campos requeridos: usuario.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!metodo) {
        return new Response(JSON.stringify({ message: 'Falta el método de pago.' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY no encontradas.");
    }

    // Crear un cliente de Supabase con la Service Role Key
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    console.log(`[LOG] Iniciando proceso para: ${usuario} | Método: ${metodo}`);

    // --- CASO A: PAGO CON MERCADO PAGO (TOKENIZADO) ---
    if (metodo === 'mercadopago') {
      const accessToken = Deno.env.get('MP_ACCESS_TOKEN');
      if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

      const missing = [];
      if (!token) missing.push('Token');
      if (!payment_method_id) missing.push('Método de Pago');
      if (!installments) missing.push('Cuotas');

      if (missing.length > 0) {
        return new Response(JSON.stringify({ message: `Error interno: Faltan datos técnicos (${missing.join(', ')}).` }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': crypto.randomUUID() // Importante para evitar pagos duplicados
        },
        body: JSON.stringify({
          transaction_amount: 400, // Monto FIJO de seguridad para pruebas
          token: token,
          description: `Premium AiduMe - ${usuario}`,
          installments: installments,
          payment_method_id: payment_method_id,
          issuer_id: issuer_id, // Opcional, pero bueno enviarlo si está disponible
          payer: { 
            email: email || `${usuario.toLowerCase()}@aidume.com`,
            identification: dni ? { type: 'DNI', number: dni } : undefined
          }
        })
      });

      const payment = await mpRes.json();

      // --- MANEJO DE ERRORES DE LA API DE MERCADO PAGO ---
      if (!mpRes.ok) {
        console.error('[MP-API-ERROR]', payment);
        const errorDetail = payment.message || (payment.cause && payment.cause[0]?.description) || 'Error en la solicitud a Mercado Pago';
        
        return new Response(JSON.stringify({ 
          message: 'Error en la comunicación con Mercado Pago.', 
          details: errorDetail 
        }), {
          status: mpRes.status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`[MP-PAYMENT] ID: ${payment.id} | Status: ${payment.status} | Detail: ${payment.status_detail}`);

      if (payment.status === 'approved') {
        const { error: upgradeError } = await supabaseAdmin
          .from('perfiles')
          .update({ es_premium: true })
          .ilike('nombre', usuario);

        if (upgradeError) throw upgradeError;

        return new Response(JSON.stringify({ message: 'Pago aprobado.' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else if (payment.status === 'in_process' || payment.status === 'pending') {
        return new Response(JSON.stringify({ message: 'Pago pendiente.', details: 'Tu pago está en revisión. El Premium se activará automáticamente cuando se apruebe.' }), {
          status: 402, // Error: Pago requerido (no finalizado)
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else if (payment.status === 'rejected') {
        let userMessage = 'El pago fue rechazado por Mercado Pago.';
        
        // Personalizamos el mensaje según el detalle del rechazo
        switch (payment.status_detail) {
          case 'cc_rejected_other_reason':
            userMessage = 'Tu tarjeta fue rechazada por el banco emisor. Intenta con otra tarjeta o contacta a tu banco.';
            break;
          case 'cc_rejected_insufficient_amount':
            userMessage = 'Fondos insuficientes en tu tarjeta.';
            break;
          case 'cc_rejected_bad_filled_security_code':
            userMessage = 'El código de seguridad de la tarjeta es incorrecto.';
            break;
        }
        return new Response(JSON.stringify({ message: 'Pago rechazado.', details: userMessage }), {
          status: 400, // Indicamos un error del cliente (pago fallido)
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else {
        console.error('[MP-PAYMENT-UNHANDLED-STATUS] Full payment object:', payment); // Log para estados no manejados
        throw new Error(`Error de Mercado Pago: ${payment.status_detail || `El pago tiene un estado no manejado: ${payment.status || 'desconocido'}.`}`);
      }
    }

  } catch (error) {
    console.error('Error al procesar la solicitud en Edge Function:', error);
    return new Response(JSON.stringify({ message: 'Error interno del servidor.', details: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});