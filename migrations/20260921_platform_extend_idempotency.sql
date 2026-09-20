-- Un reintento del extend de suscripción reusa la misma Idempotency-Key y no
-- vuelve a sumar días. La clave viaja en la metadata de la auditoría del cambio
-- y el índice parcial impide aplicarla dos veces ni siquiera en carrera.
create unique index if not exists platform_audit_log_idempotency_idx
 on platform_audit_log(actor_user_id,action,(metadata->>'idempotencyKey'))
 where metadata->>'idempotencyKey' is not null;
