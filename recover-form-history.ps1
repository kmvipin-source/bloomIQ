# recover-form-history.ps1 - v3 (inventory + alternate paths)
#
# Run with:
#   powershell -ExecutionPolicy Bypass -File .\recover-form-history.ps1

$ErrorActionPreference = "Stop"

$RepoRoot = $PSScriptRoot
$OutDir = Join-Path $RepoRoot "tmp-form-history"
$SummaryPath = Join-Path $OutDir "SUMMARY.txt"

# All known IDE history locations on Windows
$HistoryRoots = @(
    @{ Label = "VS Code (Roaming)";       Path = (Join-Path $env:APPDATA   "Code\User\History") }
    @{ Label = "VS Code Insiders";        Path = (Join-Path $env:APPDATA   "Code - Insiders\User\History") }
    @{ Label = "Cursor (Roaming)";        Path = (Join-Path $env:APPDATA   "Cursor\User\History") }
    @{ Label = "Windsurf (Roaming)";      Path = (Join-Path $env:APPDATA   "Windsurf\User\History") }
    @{ Label = "Windsurf-Next (Roaming)"; Path = (Join-Path $env:APPDATA   "Windsurf-Next\User\History") }
    @{ Label = "Windsurf (Local)";        Path = (Join-Path $env:LOCALAPPDATA "Windsurf\User\History") }
    @{ Label = "Codeium (Roaming)";       Path = (Join-Path $env:APPDATA   "Codeium\User\History") }
)

# Clean output dir
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

$Lines = @()
$Lines += "=== Form-history recovery scan v3 ==="
$Lines += "Run at:  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$Lines += ""

$grandTotalFound = @()

foreach ($root in $HistoryRoots) {
    $label = $root.Label
    $path = $root.Path

    if (-not (Test-Path $path)) {
        $Lines += "[$label] does not exist"
        continue
    }

    $folders = Get-ChildItem $path -Directory -ErrorAction SilentlyContinue
    $totalFolders = $folders.Count

    # Project inventory: count distinct top-level project folders mentioned in all entries.json files
    $projectCount = @{}
    $bloomiqFolders = @()
    $teacherFolders = @()
    $teacherGenerateFolders = @()

    foreach ($folder in $folders) {
        $entriesPath = Join-Path $folder.FullName "entries.json"
        if (-not (Test-Path $entriesPath)) { continue }
        try {
            $content = Get-Content $entriesPath -Raw -ErrorAction Stop
        } catch { continue }

        # Extract project name from resource URI:
        # file:///c%3A/Users/kmvip/bloomiq/...  ->  project = "bloomiq"
        if ($content -match 'file:///c%3A/Users/kmvip/([^/]+)/') {
            $proj = $matches[1]
            if (-not $projectCount.ContainsKey($proj)) { $projectCount[$proj] = 0 }
            $projectCount[$proj]++
        } elseif ($content -match 'file:///c%3A/[^/]+/([^/]+)/') {
            $proj = "OTHER:" + $matches[1]
            if (-not $projectCount.ContainsKey($proj)) { $projectCount[$proj] = 0 }
            $projectCount[$proj]++
        }

        $low = $content.ToLower()
        if ($low.Contains("bloomiq")) { $bloomiqFolders += $folder }
        if ($low.Contains("/teacher/")) { $teacherFolders += $folder }
        if ($low.Contains("/teacher/") -and $low.Contains("generate") -and $low.Contains("page.tsx")) {
            $teacherGenerateFolders += $folder
        }
    }

    $Lines += "[$label]  total folders: $totalFolders"
    $Lines += "  Projects found:"
    foreach ($k in ($projectCount.Keys | Sort-Object { -$projectCount[$_] })) {
        $Lines += "    $($projectCount[$k].ToString().PadLeft(4)) x  $k"
    }
    $Lines += "  bloomiq references: $($bloomiqFolders.Count) folder(s)"
    $Lines += "  ANY /teacher/ file:  $($teacherFolders.Count) folder(s)"
    $Lines += "  /teacher/generate/page.tsx exact hit: $($teacherGenerateFolders.Count) folder(s)"

    if ($teacherGenerateFolders.Count -gt 0) {
        foreach ($f in $teacherGenerateFolders) {
            $Lines += "    HIT folder: $($f.Name)  ->  $($f.FullName)"
            Get-ChildItem $f.FullName -File -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne "entries.json" } |
                ForEach-Object { $grandTotalFound += @{ Label = $label; File = $_ } }
        }
    }
    $Lines += ""
}

# Copy any snapshots we did find
$sorted = $grandTotalFound | Sort-Object { $_.File.LastWriteTime } -Descending | Select-Object -First 30
$Lines += ""
$Lines += "=== $($sorted.Count) total snapshot(s) found across all IDEs ==="
$Lines += ""

if ($sorted.Count -gt 0) {
    $i = 0
    foreach ($hit in $sorted) {
        $i++
        $snap = $hit.File
        $stamp = $snap.LastWriteTime.ToString("yyyy-MM-dd_HHmm")
        $newName = ("snap-{0:D2}-{1}-{2}.tsx" -f $i, $stamp, $snap.Length)
        $dest = Join-Path $OutDir $newName
        Copy-Item -Path $snap.FullName -Destination $dest -Force
        $line = "  {0,2}. [{1,-20}]  {2}  {3,7} bytes  ->  {4}" -f $i, $hit.Label, $snap.LastWriteTime.ToString("yyyy-MM-dd HH:mm"), $snap.Length, $newName
        $Lines += $line
    }
    $Lines += ""
    $Lines += "Files copied to: $OutDir"
} else {
    $Lines += "No exact /teacher/generate/page.tsx matches anywhere."
    $Lines += "Look at the inventory above - does it list bloomiq references and /teacher/ files?"
    $Lines += "If yes, the simplification work was edited in an IDE we DID scan, but never touched the teacher/generate file specifically."
    $Lines += "If 'bloomiq references: 0' across all IDEs, your edits werent in an IDE - they came from a different tool (terminal Claude Code, agent script, etc.)."
}

$Lines | Out-File -FilePath $SummaryPath -Encoding utf8
$Lines | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "Done. Summary at: $SummaryPath" -ForegroundColor Green
