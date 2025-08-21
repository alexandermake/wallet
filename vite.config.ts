import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const port = process.env.port ? Number(process.env.port) : 8080;

export default defineConfig({
  base: "./",
  server: {
    host: "0.0.0.0",
    port
  },
  define: {
    "import.meta.env.APP_VERSION": JSON.stringify(process.env.npm_package_version)
  },
  plugins: [
    nodePolyfills({
      include: ["stream", "util", "crypto", "http", "https", "vm", "zlib"],
      globals: {
        Buffer: true,
        global: true,
        process: true
      }
    })
  ],
  build: {
    minify: "terser",
    chunkSizeWarningLimit: 750,
    terserOptions: {
      keep_fnames: true,
      compress: {
        drop_console: true,
        drop_debugger: true
      },
      format: {
        comments: false
      }
    },
    copyPublicDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            const parts = id.split("node_modules/")[1].split("/");
            const pkg = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
            return `vendor_${pkg}`;
          }
        }
      }
    }
  }
});
