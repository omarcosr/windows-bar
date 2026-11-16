# Publicando versões

Os releases são gerados pelo GitHub Actions (`.github/workflows/release.yml`) com o instalador, o empacotamento e o updater do Tarve.

## Publicar

1. Atualize `version` no `package.json` e faça o commit.
2. Crie e envie a tag:

   ```powershell
   git tag v0.2.0; git push origin v0.2.0
   ```

   Ou use **Actions → release → Run workflow** informando a versão.

O workflow publica em Releases:

| Arquivo | Para quê |
| --- | --- |
| `WindowsBar-Setup-<v>-win32-x64.exe` | Instalador (por usuário, em `%LOCALAPPDATA%\Programs\WindowsBar`) |
| `WindowsBar-<v>-windows-x64.zip` | Versão portátil |
| `WindowsBar-<v>-win32-x64.exe` | Executável baixado pelo updater |
| `latest.json` | Manifesto assinado que o app consulta (enviado por último) |

## Chave de assinatura

As atualizações são assinadas com Ed25519. A chave privada fica em `windows-bar-update.key` (gerada com `bunx tarve keygen`, fora do git) e no secret `TARVE_UPDATE_PRIVATE_KEY` do repositório; a chave pública está em `src/services/updater.ts` e `scripts/release.ts`.

```powershell
Get-Content -Raw windows-bar-update.key | gh secret set TARVE_UPDATE_PRIVATE_KEY --repo omarcosr/windows-bar
```

Guarde um backup da chave: sem ela, as cópias instaladas não aceitam novas versões.

## Release local

```powershell
bun run release 0.2.0             # dist/release (instalador e zip) e dist/updates (exe e latest.json)
bun run release 0.2.0 --publish   # o mesmo, e cria o release v0.2.0 com o gh
```

Feche o WindowsBar que estiver rodando de `dist\WindowsBar.exe` antes: o arquivo fica em uso.

O instalador é configurado em `tarve.installer` no `package.json`: ele roda `WindowsBar.exe --quit` antes de instalar ou desinstalar e `--autostart on|off` para a opção de iniciar com o Windows.
