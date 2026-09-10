// User-provided Trello screenshots (2026-09-10) and Segundo Cerebro commercial sources.
export const board='https://trello.com/b/OLqcnrOx/scale';
export const pricingSource='Segundo Cerebro: Scale - Manual de servicios 2026 (06/09/2026) y Scale - pricing 2026 bitacora de decisiones (31/08/2026)';
const conditions='Precios mensuales + IVA 10%. Pago 100% adelantado del 1 al 5. Plazo mínimo sugerido: 3 meses. Incluye 2 rondas de corrección. Cancelación con 15 días de aviso. No incluye community management, pauta, stories, fotos de producto, garantía de seguidores ni revisiones ilimitadas.';
export const plans=[
 {name:'Silver',price:4000000,scope:'8 contenidos mensuales; 1 jornada de grabación; edición profesional con identidad visual; calendarización mensual; entrega por Drive; análisis previo del perfil y acompañamiento creativo.'},
 {name:'Gold',price:6000000,scope:'12 contenidos mensuales; 1 jornada de grabación; edición profesional con identidad visual y transiciones; calendarización estratégica; estrategia básica; Drive; reunión mensual de revisión de 30 minutos; acompañamiento creativo continuo.'},
 {name:'Diamond',price:9000000,scope:'15 contenidos mensuales; 2 jornadas de grabación; edición premium con motion graphics y color grading; estrategia mensual completa y documentada; reunión estratégica de 60 minutos; reporte mensual de métricas; prioridad de respuesta y ajustes en 24 horas.'},
].map(p=>({name:p.name,currency:'PYG',items:[{description:`Plan ${p.name} mensual · ${p.scope}`,quantity:1,unitPrice:p.price}],notes:`${conditions}\n\nFuente: ${pricingSource}.`}));
export const cards=[
 ['MKT Clínica','MKT Clínica — validación de preguntas con Dr. Javier','blocked','Checklist 0/6. Responsable en Trello: Ucraniano90.'],
 ['Asisteck','Asisteck — esperando respuesta de Luis','blocked','Checklist 0/6.'],
 ['Zampy','Zampy — esperamos respuesta del cliente','blocked',''],
 ['LEDBOX','LEDBOX — esperamos respuesta del cliente','blocked',''],
 ['Patria/Darío','Patria/Darío — retocar guiones Tanda 2 (1 reel + 2 historias)','to_record','Checklist 0/6. Responsable en Trello: Dario Deoli Help. Vencimiento original 08/09/2026 10:00 marcado completado en Trello; la tarjeta sigue en Por grabar. Eric, 08/09 11:09: equipo en producción/grabación de 1 reel + 2 historias.'],
 ['Ponderoso','Ponderoso — contenido en conjunto (colab IG) sube Ucra','to_record','Checklist 0/4. Responsable en Trello: Ucraniano90. Vencimiento original 07/09/2026 18:00 marcado completado; la tarjeta sigue en Por grabar.'],
 ['Springfield','Springfield (Ucra) — subir contenido de la carpeta compartida por Jake','to_record','Checklist 0/4. Responsable en Trello: Ucraniano90. No se proporcionó la URL de Drive.'],
 ['Ponderoso','Ponderoso — nueva tanda de contenidos + agendar día de producción','to_record',''],
 ['Tiendy','Tiendy — grabar 3 videos restantes con Ucra','to_record','Responsable en Trello: Ucraniano90. Eric, 08/09 11:09: producción/grabación de 3 videos con Darío, confirmada por Fer.'],
 ['Ponderoso','Ponderoso — subir 5 videos ya editados al Drive','editing','Checklist 0/4. No se proporcionó la URL de Drive.'],
 ['Tiendy','Tiendy — 4/5 videos restantes del mes','editing','Checklist 0/3.'],
 ['Bristol','Bristol — resumen de cobertura atrasado','review','Checklist 0/3.'],
 ['Luis Sushi','Luis Sushi — publicar pieza editada','review','Checklist 0/2. Pendiente de revisión, no publicada.'],
 ['Bucan','Bucan — historia + reel pendientes, más promo CapCut Pro','review','Checklist 1/9. Eric, 07/09 16:50: estrategia Sistema Bucan Siempre Activa entregada a Fer. Resto de pasos no proporcionados.'],
];
export const internal=[
 ['Oferta 10% descuento por referidos — redactar y validar mensaje','Checklist 5/9. Eric completó 07/09 15:48: redactar, validar mensaje, armar y validar lista, envío a Bucan, Asisteck, Tiendy, Sole, Luis Sushi y Ponderoso. No se aplicaron descuentos financieros.',''],
 ['Lista de servicios de Scale (mensaje único para clientes/prospectos)','Checklist 0/4.',''],
 ['Investigar propuesta de Federico Bogado (@federicobogadovc)','Checklist 0/3.',''],
 ['Compartir manual de flujos de trabajo con Ario, Ucra y César','Checklist 0/4. Responsables en Trello: Eric Baccon y Ucraniano90.',''],
 ['Coberturas — facturar (pago miércoles)','Título anterior: Coberturas — Marcelo necesita facturar (pago miércoles). Responsable en Trello: Eric Baccon. Fecha original relativa: «ayer a las 9:00» (registro 07/09). No se infiere una fecha exacta, factura ni cobro.',''],
 ['Ucra — retomar streams (Jake pasa los clips primero)','Responsables en Trello: Jake Andino exe y Ucraniano90. Rita fue retirada el 07/09. Eric completó el paso Jake entrega los 7 clips del stream a Ucra el 07/09 17:22.',''],
 ['Scale (contenido propio) — Ario busca ideas y pasa al grupo','',''],
 ['Sole — reunión mañana 1pm','Fecha original 08/09/2026 13:00. Eric se unió a la tarjeta.','2026-09-08'],
 ['Ponderoso — conseguir acceso a la cuenta de TikTok','',''],
 ['Jake — video de Scale (contenido propio) sin entregar','Responsable en Trello: Jake Andino exe.',''],
 ['Cesar — reunión con su cliente hoy 21:30','Fecha original 08/09/2026 21:30. Eric indicó que César no era miembro del tablero y avisaría por WhatsApp aparte.','2026-09-08'],
 ['Reunión Sole/TikTok — hoy 13:00 (confirmada)','Fecha original 08/09/2026 13:00. Responsable en Trello: Rita Mical Herrera. Se conserva como tarjeta distinta de Sole — reunión mañana 1pm porque ambas aparecen en la fuente.','2026-09-08'],
];
