import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'production-content-security-policy',
      apply: 'build',
      transformIndexHtml(html: string) {
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: ofimg: https:",
          "font-src 'self' data: https:",
          "connect-src 'self' https: wss:",
          "frame-src https:",
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'"
        ].join('; ')
        return html.replace('</head>', `  <meta http-equiv="Content-Security-Policy" content="${policy}" />\n  </head>`)
      }
    }
  ],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true
  }
})
