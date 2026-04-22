import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.0.0?target=deno'

Deno.serve(async (req) => {
  // Solo permitimos solicitudes POST para procesar pagos
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ message: 'Método no permitido. Solo POST.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { usuario, referencia, monto, metodo, stripeToken } = await req.json();

    // Validaciones básicas
    if (!usuario || !monto) {
      return new Response(JSON.stringify({ message: 'Faltan campos requeridos: usuario, referencia, monto.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Crear un cliente de Supabase con la Service Role Key
    // Esta clave tiene acceso total y SOLO debe usarse en el servidor (Edge Function)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // --- CASO A: PAGO CON TARJETA (AUTOMÁTICO) ---
    if (metodo === 'tarjeta' && stripeToken) {
      const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
        apiVersion: '2022-11-15',
        httpClient: Stripe.createFetchHttpClient(),
      });

      // Creamos el cargo real ($4.00 USD = 400 centavos)
      const charge = await stripe.charges.create({
        amount: 400,
        currency: 'usd',
        source: stripeToken,
        description: `Premium AiduMe - Usuario: ${usuario}`,
      });

      if (charge.paid) {
        // ACTIVACIÓN INSTANTÁNEA: El pago es real, le damos el premium ya mismo
        const { error: upgradeError } = await supabaseAdmin
          .from('perfiles')
          .update({ es_premium: true })
          .eq('nombre', usuario);

        if (upgradeError) throw upgradeError;

        return new Response(JSON.stringify({ message: 'Cobro y activación exitosa.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // --- CASO B: TRANSFERENCIA (MANUAL) ---
    const { data, error } = await supabaseAdmin
      .from('pagos_pendientes')
      .insert([{
        usuario: usuario,
        referencia: referencia || 'TRANSF_INTERNA',
        monto: monto,
        estado: 'pendiente'
      }])
      .select();

    if (error) {
      console.error('Error al insertar en Supabase desde Edge Function:', error);
      return new Response(JSON.stringify({ message: 'Error al guardar la solicitud de pago.', details: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ message: 'Solicitud de pago enviada con éxito.', data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error al procesar la solicitud en Edge Function:', error);
    return new Response(JSON.stringify({ message: 'Error interno del servidor.', details: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});