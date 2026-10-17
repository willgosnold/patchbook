// Markdown imported `with { type: "text" }`, which Bun gives as a string and embeds in the binary.
declare module "*.md" {
  const text: string;
  export default text;
}
