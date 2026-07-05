import './globals.css';

export const metadata = {
  title: 'QA Cumplimiento',
  description: 'Dashboard de evidencia de calidad y cumplimiento',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
