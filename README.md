# react-flash-games
Create flash games using React and Three.js.

## Development

```bash
npm install
npm run dev
```

Build for production with `npm run build`.

## itch.io HTML Upload

The game is designed around a responsive `960x540` 16:9 viewport and scales down for smaller embeds. Use `960x540` as the recommended itch.io embed size; mobile and narrow embeds can scroll vertically when a screen needs more height.

Run `npm run build`, then zip the contents of `dist/` with `index.html` at the ZIP root. Upload the ZIP as an HTML game with relative asset paths enabled by the Vite config.
