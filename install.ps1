# install.ps1 — one-shot installer for dsh-vision-bridge.
#
# What it does:
#   1. copies the plugin files into <DSH_HOME>/profiles/web/
#   2. registers the dsh-view-image row in the profile's cordis.patch.yml
#   3. declares image input for your text-only model in settings.yaml
#      (llm-pi-ai.providers.<Provider>.modelOverrides.<Model>.input = [text, image])
#   4. writes vision-bridge-config.json (vision endpoint URL + key — REQUIRED,
#      asked interactively when no -ApiBase parameter is given)
#   5. applies the pi-ai adapter patch (apply-vision-patch.js)
#   6. runs the plugin self-test
#
# The vision endpoint is ALWAYS explicit (URL + key). Examples:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ApiBase https://api.openai.com/v1 -ApiKeyEnv OPENAI_API_KEY -VisionModel gpt-5.1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ApiBase https://api.x.ai/v1 -ApiKeyEnv XAI_API_KEY -VisionModel grok-4-fast
#   powershell -ExecutionPolicy Bypass -File install.ps1                    # asks for the endpoint interactively
#   powershell -ExecutionPolicy Bypass -File install.ps1 -NonInteractive     # skips endpoint setup (do it by hand later)
#
# After the script finishes, restart dsh web, then send an image in a session.

param(
    [string]$Provider = 'opencode-go',
    [string]$Model = 'deepseek-v4-pro',
    [string]$ApiBase = '',
    [string]$ApiKeyEnv = '',
    [string]$ApiKey = '',
    [string]$VisionModel = '',
    [switch]$SkipSettings,
    [switch]$NonInteractive
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$webDir = Join-Path $dshHome 'profiles\web'
$patchYml = Join-Path $webDir 'cordis.patch.yml'
$settingsYml = Join-Path $dshHome 'settings.yaml'
$configJson = Join-Path $webDir 'vision-bridge-config.json'
$rowMarker = 'dsh-view-image'

Write-Host "DSH home : $dshHome"
Write-Host "Web dir  : $webDir"
Write-Host ''

if (-not (Test-Path $webDir)) {
    throw "DSH web profile directory not found: $webDir`nMake sure DeepSeek Harness is installed and `dsh web` has been booted at least once."
}

# 1) copy plugin files
Write-Host '[1/6] copying plugin files ...'
# 布局兼容：plugin/（当前）＞ payload/（0.1.x 历史）＞ 仓库根目录
$pluginSource = if (Test-Path (Join-Path $PSScriptRoot 'plugin')) { Join-Path $PSScriptRoot 'plugin' } elseif (Test-Path (Join-Path $PSScriptRoot 'payload')) { Join-Path $PSScriptRoot 'payload' } else { $PSScriptRoot }
foreach ($file in @('dsh-view-image.js', 'apply-vision-patch.js')) {
    Copy-Item (Join-Path $pluginSource $file) (Join-Path $webDir $file) -Force
    Write-Host "       copied $file"
}

# 2) register the plugin row in cordis.patch.yml
Write-Host '[2/6] registering plugin row ...'
$patch = if (Test-Path $patchYml) { Get-Content $patchYml -Raw -Encoding UTF8 } else { '' }
if ($patch.Contains($rowMarker)) {
    Write-Host '       row already present, skipped'
} else {
    $row = @"

# dsh-vision-bridge: 视觉桥接工具 view_image（自动看图）+ 补丁在位检查。
# 移除本块即可停用。自测：node dsh-view-image.js
- insert:
    - id: $rowMarker
      name: './dsh-view-image.js'
"@
    if (-not $patch.EndsWith("`n")) { $patch += "`n" }
    $patch += $row
    [System.IO.File]::WriteAllText($patchYml, ($patch -replace "`r?`n", "`r`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Host '       row added'
}

# 3) declare image input in settings.yaml
if ($SkipSettings) {
    Write-Host '[3/6] -SkipSettings: skipping model override (do it by hand)'
} else {
    Write-Host "[3/6] declaring image input for $Provider / $Model ..."
    $settings = Get-Content $settingsYml -Raw -Encoding UTF8
    if ($settings.Contains('dsh-vision-bridge')) {
        Write-Host '       model override already present, skipped'
    } else {
        $block = @"
      modelOverrides:
        $Model`:
          input:
            - text
            - image
"@
        $needle = "    ${Provider}:"
        if ($settings.Contains($needle)) {
            $settings = $settings.Replace($needle, ($needle + "`r`n" + $block.TrimEnd() + "`r`n" + '# dsh-vision-bridge: model override (image input declaration)'))
        } else {
            if (-not $settings.EndsWith("`n")) { $settings += "`n" }
            $settings += @"

llm-pi-ai:
  providers:
    ${Provider}:
      modelOverrides:
        ${Model}:
          input:
            - text
            - image
# dsh-vision-bridge: model override (image input declaration)
"@
        }
        [System.IO.File]::WriteAllText($settingsYml, ($settings -replace "`r?`n", "`r`n"), [System.Text.UTF8Encoding]::new($false))
        Write-Host '       model override written'
    }
}

# 4) vision endpoint config (REQUIRED: URL + key; no built-in provider)
Write-Host '[4/6] vision endpoint configuration ...'
$existing = if (Test-Path $configJson) { Get-Content $configJson -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
if ($ApiBase -or $ApiKeyEnv -or $ApiKey -or $VisionModel) {
    $cfg = [ordered]@{}
    if ($ApiBase) { $cfg['apiBase'] = $ApiBase } elseif ($existing.apiBase) { $cfg['apiBase'] = $existing.apiBase }
    if ($VisionModel) { $cfg['model'] = $VisionModel } elseif ($existing.model) { $cfg['model'] = $existing.model }
    if ($ApiKeyEnv) { $cfg['apiKeyEnv'] = $ApiKeyEnv } elseif ($existing.apiKeyEnv) { $cfg['apiKeyEnv'] = $existing.apiKeyEnv }
    if ($ApiKey) { $cfg['apiKey'] = $ApiKey } elseif ($existing.apiKey) { $cfg['apiKey'] = $existing.apiKey }
    $jsonText = ($cfg | ConvertTo-Json -Depth 4) -replace "`r?`n", "`r`n"
    [System.IO.File]::WriteAllText($configJson, $jsonText, [System.Text.UTF8Encoding]::new($false))
    Write-Host '       written from parameters'
} elseif ($existing) {
    Write-Host '       existing vision-bridge-config.json kept'
} elseif ($NonInteractive) {
    Write-Host '       -NonInteractive: endpoint NOT configured — set vision-bridge-config.json by hand before use'
} else {
    Write-Host '       (leave blank to skip a field)'
    $base = Read-Host '       apiBase  (e.g. https://api.openai.com/v1)'
    if ($base) {
        $vm = Read-Host '       model    (e.g. gpt-5.1)'
        $envName = Read-Host '       apiKeyEnv (e.g. OPENAI_API_KEY; blank to use apiKey directly)'
        $key = if ($envName) { '' } else { Read-Host '       apiKey   (paste key; stored only in this local file)' }
        $cfg = [ordered]@{ apiBase = $base }
        if ($vm) { $cfg['model'] = $vm }
        if ($envName) { $cfg['apiKeyEnv'] = $envName }
        if ($key) { $cfg['apiKey'] = $key }
        $jsonText = ($cfg | ConvertTo-Json -Depth 4) -replace "`r?`n", "`r`n"
        [System.IO.File]::WriteAllText($configJson, $jsonText, [System.Text.UTF8Encoding]::new($false))
        Write-Host '       written'
    } else {
        Write-Host '       endpoint NOT configured — set vision-bridge-config.json by hand before use'
    }
}

# 5) apply the adapter patch
Write-Host '[5/6] applying pi-ai adapter patch ...'
Push-Location $webDir
try {
    node apply-vision-patch.js
    if ($LASTEXITCODE -ne 0) { throw 'apply-vision-patch.js failed' }
} finally {
    Pop-Location
}

# 6) self-test
Write-Host '[6/6] running self-test ...'
Push-Location $webDir
try {
    node dsh-view-image.js
    if ($LASTEXITCODE -ne 0) { throw 'self-test failed (configure the vision endpoint if the live call failed)' }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Installation finished. Restart dsh web, then send an image in any session to verify.'
Write-Host 'Upgrade note: after every dsh upgrade/reinstall, run:  node apply-vision-patch.js  (inside the web profile dir)'
