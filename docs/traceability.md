# Matriz de trazabilidad inicial

Esta matriz arranca con el mapeo declarado en el plan de referencia y debe convertirse en fuente viva cuando se implementen los CP.

| Caso | Objetivo tecnico | Marco asociado | Estado |
| --- | --- | --- | --- |
| CP-01 | Borrado/cancelacion de datos | GDPR, CCPA/CPRA, LFPDPPP pendiente | Faltante: mecanismo no implementado en este nivel |
| CP-02 | Opt-out/no venta o uso restringido | CCPA/CPRA | Planeado: Integración de banderas de consentimiento en perfil de usuario |
| CP-03 | Acceso DSAR/ARCO | GDPR, LFPDPPP pendiente | Faltante: mecanismo no implementado en este nivel |
| CP-04 | Auditoría y trazabilidad de interacciones | ISO/IEC 42001, cumplimiento operativo | Planeado: Logs de decisiones y cambios de estado de tools |
| CP-05 | Disponibilidad y rate-limiting bajo carga | Servicio/cumplimiento operativo | Planeado: Control de tasa de solicitudes y alertas de degradación |
| CP-06 | Aislamiento multi-tenant y segregación de datos | Seguridad organizacional, cumplimiento MSP | Planeado: Validación de scope y bloqueo de acceso cross-tenant |
| CP-07 | Portabilidad/export de datos | GDPR | Pendiente: Formato de exportación (JSON/CSV) por definir |
| CP-08 | Privacidad/limitacion de uso | GDPR, CCPA/CPRA | Pendiente: Restricción de procesamiento por consentimiento |
| CP-09 | Gobernanza AIMS | ISO/IEC 42001 | Pendiente: Documentación de decisiones de IA y cambios de modelo |
| CP-10 | Evidencia y mejora continua AIMS | ISO/IEC 42001 | Pendiente: Mecanismo de feedback y loop de mejora |
| CP-11 | Consistencia RAG/chat, cache segura y eficiencia de tokens | ISO/IEC 42001, eficiencia operativa, seguridad multi-tenant | Planeado: Fase 2.5 definida en plan.md |

Pendiente legal: validar requisitos especificos de LFPDPPP para derechos ARCO y aviso de privacidad antes de cerrar el mapeo nacional de Mexico.
