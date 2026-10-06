// Configuración pública de la aplicación.
//
// La clave "anon" de Supabase es pública por diseño: la seguridad la da
// RLS en la base de datos (ver supabase/schema.sql).
// NUNCA pongas aquí la clave "service_role" ni la contraseña de la base de datos.
window.CONFIG = {
  SUPABASE_URL: 'https://hclsiolhjnivdnlzrcha.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjbHNpb2xoam5pdmRubHpyY2hhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEzMTQ1NDMsImV4cCI6MjEwNjg5MDU0M30.I9xbqnmMDR4YCZhZefu1gOJEUGGbkkGw8OXtNtuMJ9I',

  // Si el usuario escribe solo "admin", se usa "admin@sistema-mayor.local".
  DOMINIO_USUARIOS: 'sistema-mayor.local',

  // Cantidad igual o menor a esta se marca como "pocas unidades".
  STOCK_BAJO: 5,

  // Zona horaria de todo el sistema: horas mostradas, qué ventas entran en
  // el cierre de cada día y fechas de los reportes. Caracas = UTC-4.
  ZONA_HORARIA: 'America/Caracas',
};
