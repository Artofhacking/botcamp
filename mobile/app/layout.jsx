export const metadata = { title: 'BotCamp', viewport: 'width=device-width, initial-scale=1, viewport-fit=cover' }
export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: '#0b0b0d', color: '#e8e8ee', fontFamily: 'system-ui,-apple-system,"PingFang SC",sans-serif' }}>
        {children}
      </body>
    </html>
  )
}
