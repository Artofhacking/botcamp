import './globals.css'
export const metadata = {
  title: 'BotCamp',
  manifest: '/m/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'BotCamp' },
  icons: { icon: '/m/icon-192.png', apple: '/m/icon-192.png' },
}
export const viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0b0b0d' }
export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#0b0b0d', color: '#e8e8ee', fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif' }}>
        {children}
      </body>
    </html>
  )
}
