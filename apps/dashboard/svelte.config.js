import adapter from "@sveltejs/adapter-static"

const config = {
  kit: {
    adapter: adapter({ fallback: "200.html" }),
    inlineStyleThreshold: 20_000,
    paths: { base: process.env.BASE_PATH ?? "" },
  },
}

export default config
