# SHOWhisper installer for Windows (x64).
#
#   irm https://raw.githubusercontent.com/adziendziolD/SHOWhisper/main/scripts/install-windows.ps1 | iex
#
# Downloads the latest release setup .exe from GitHub and runs it. The
# installer is per-user (no admin rights needed) and starts SHOWhisper when
# done. Later versions are installed automatically by the built-in updater.
#
# Wrapped in a script block so nothing leaks into the caller's session and
# errors don't close the window (no `exit` when run via `iex`).

& {
    $ErrorActionPreference = 'Stop'
    # Invoke-WebRequest's progress bar slows downloads dramatically on Windows PowerShell 5.1.
    $ProgressPreference = 'SilentlyContinue'
    # Windows PowerShell 5.1 may default to TLS 1.0; GitHub requires TLS 1.2+.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = 'adziendziolD/SHOWhisper'
    $api = "https://api.github.com/repos/$repo/releases/latest"

    function Write-Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    if ($arch -eq 'ARM64') {
        Write-Host 'Note: installing the x64 build, which runs under Windows on ARM emulation.' -ForegroundColor Yellow
    } elseif ($arch -ne 'AMD64') {
        throw "SHOWhisper needs 64-bit Windows 10/11 (this machine: $arch)."
    }

    Write-Step 'Looking up the latest SHOWhisper release...'
    $headers = @{ 'User-Agent' = 'SHOWhisper-installer'; 'Accept' = 'application/vnd.github+json' }
    if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
    try {
        $release = Invoke-RestMethod -Uri $api -Headers $headers
    } catch {
        throw "Could not reach the GitHub API: $($_.Exception.Message)"
    }

    $asset = $release.assets | Where-Object { $_.name -like '*-windows-x64-setup.exe' } | Select-Object -First 1
    if (-not $asset) { $asset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1 }
    if (-not $asset) { throw "No Windows installer found in release $($release.tag_name). See https://github.com/$repo/releases" }

    $setup = Join-Path ([IO.Path]::GetTempPath()) $asset.name
    Write-Step "Downloading SHOWhisper $($release.tag_name)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $setup -UseBasicParsing -Headers @{ 'User-Agent' = 'SHOWhisper-installer' }

    $running = Get-Process -Name 'SHOWhisper' -ErrorAction SilentlyContinue
    if ($running) {
        Write-Step 'Closing the running SHOWhisper...'
        $running | Stop-Process -Force
        Start-Sleep -Seconds 2
    }

    Write-Step 'Running the installer...'
    $proc = Start-Process -FilePath $setup -PassThru -Wait
    Remove-Item $setup -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) { throw "The installer exited with code $($proc.ExitCode)." }

    Write-Host ''
    Write-Host "SHOWhisper $($release.tag_name) installed." -ForegroundColor Green
    Write-Host '  - It lives in the system tray. Press Alt+Space to dictate.'
    Write-Host '  - The Whisper model (~450 MB) downloads on first use, then everything runs offline.'
}
