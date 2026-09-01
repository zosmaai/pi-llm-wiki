import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://zosmaai.github.io",
  base: "/pi-llm-wiki",
  integrations: [
    starlight({
      title: "pi-llm-wiki",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/zosmaai/pi-llm-wiki",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Architecture", slug: "architecture" },
        { label: "Configuration", slug: "configuration" },
        { label: "Commands", slug: "commands" },
        { label: "API Reference", slug: "api" },
        { label: "Obsidian Integration", slug: "obsidian" },
      ],
    }),
  ],
});
