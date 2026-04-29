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
    const body = await req.json();
    // Asignamos un monto por defecto de 0 si no viene en el body
    const { usuario, metodo, email, monto = 0, referencia } = body;

    if (!usuario) {
      return new Response(JSON.stringify({ message: 'Faltan campos requeridos: usuario.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Crear un cliente de Supabase con la Service Role Key
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    console.log(`[LOG] Iniciando proceso para: ${usuario} | Método: ${metodo}`);

    // --- CASO A: PAGO CON MERCADO PAGO (TOKENIZADO) ---
    if (metodo === 'mercadopago') {
      const accessToken = Deno.env.get('MP_ACCESS_TOKEN');
      if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

      const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': crypto.randomUUID()
        },
        body: JSON.stringify({
          transaction_amount: 4000,
          token: body.token,
          description: `Premium AiduMe - ${usuario}`,
          installments: body.installments,
          payment_method_id: body.payment_method_id,
          issuer_id: body.issuer_id,
          payer: { email: email || 'usuario@aidume.com', identification: body.identification }
        })
      });

      const payment = await mpRes.json();

      // --- MANEJO DE ERRORES DE LA API DE MERCADO PAGO ---
      if (!mpRes.ok) {
        console.error('[MP-API-ERROR]', payment);
        // Extraemos el mensaje de error de Mercado Pago o la causa específica
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
        return new Response(JSON.stringify({ message: 'Pago pendiente de acreditación.', details: payment.status_detail }), {
          status: 200, // Respondemos 200 para que la UI no lo tome como error crítico
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else if (payment.status === 'rejected') {
        // Manejo específico para pagos rechazados
        return new Response(JSON.stringify({ message: 'Pago rechazado.', details: payment.status_detail || 'El pago fue rechazado por Mercado Pago.' }), {
          status: 400, // Indicamos un error del cliente (pago fallido)
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } else {
        console.error('[MP-PAYMENT-UNHANDLED-STATUS] Full payment object:', payment); // Log para estados no manejados
        throw new Error(`Error de Mercado Pago: ${payment.status_detail || `El pago tiene un estado no manejado: ${payment.status || 'desconocido'}.`}`);
      }
    }

    // --- CASO B: TRANSFERENCIA (MANUAL) O FALLBACK ---
    const { data, error } = await supabaseAdmin
      .from('pagos_revision')
      .insert([{
        usuario: usuario,
        referencia: referencia || 'TRANSF_INTERNA',
        monto: monto,
        estado: 'pendiente'
      }])
      .select();

    if (error) {
      console.error('[ERROR DB]', error);
      return new Response(JSON.stringify({ message: 'Error en base de datos.', details: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: 'Solicitud de pago enviada con éxito.', data }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error al procesar la solicitud en Edge Function:', error);
    return new Response(JSON.stringify({ message: 'Error interno del servidor.', details: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});