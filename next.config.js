/** @type {import('next').NextConfig} */
const nextConfig = {
  // Origenes permitidos para recursos de desarrollo (HMR y chunks de cliente).
  // Incluimos localhost y la red local (LAN) porque el server tambien se expone
  // por la IP de red: si abres la UI por http://<IP-de-red>:3000 y esta IP no
  // esta aqui, Next.js bloquea el JS de cliente (403), la pagina no hidrata y
  // los botones "Lanzar" dejan de responder aunque el backend funcione.
  allowedDevOrigins: [
    '127.0.0.1',
    'localhost',
    '172.16.*.*',
    '10.*.*.*',
    '192.168.*.*',
  ],
  output: 'standalone',
};

module.exports = nextConfig;
