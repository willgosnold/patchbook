# patchbook

Keep your changes to an upstream repo, each with its intent, and keep pulling from upstream.

```sh
npm install --save-dev patchbook
npx patchbook --version
```

The package holds a small launcher. The compiled binary comes from an optional dependency named for your platform (`@patchbook/linux-x64`, `@patchbook/darwin-arm64` and so on), so don't install with `--omit=optional`.

Without Node, `curl -fsSL https://raw.githubusercontent.com/willgosnold/patchbook/main/install.sh | sh` installs the same binary into `~/.local/bin`.

Docs and source: https://github.com/willgosnold/patchbook
