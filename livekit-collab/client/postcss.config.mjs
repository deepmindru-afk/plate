// This demo lives inside a monorepo whose root PostCSS config uses Tailwind
// (not installed here). Shadow it with an empty config so the client's Vite
// build doesn't inherit the parent repo's Tailwind pipeline.
export default { plugins: {} };
