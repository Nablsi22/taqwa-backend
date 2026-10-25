# ═══════════════════════════════════════════════════════════════════════════
# verify-attendance-foundation.ps1 — confirms every Phase 1 file on disk is
# byte-identical to what was tested, then type-checks and runs the tests.
# Read-only: it changes no source file and touches no database.
#
# Usage (from D:\taqwa-app\taqwa_mobile):
#   powershell -ExecutionPolicy Bypass -File .\backend\scripts\verify-attendance-foundation.ps1
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$files = @(
  @{ Path = 'backend\prisma\migrations\20261022000000_attendance_foundation\migration.sql'; Hash = 'AD858F945D9F520767E869FDD47567040AD0B5CE387BE4EC8713C9E9FF8DF455' }
  @{ Path = 'backend\prisma\schema.prisma'; Hash = 'C37C53CEC80252209AD33DBE573776210B80E1B0482CF41218BEFE90682DA3F7' }
  @{ Path = 'backend\src\app.module.ts'; Hash = '6E3A8532174FDE2929D87C5FD5A8066C7161D5EF92E8A7BABBD20591BE5F8150' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.controller.ts'; Hash = 'D5400F702F30F478EC69F97C1ECE99CC714A2EC9E3016806AA6399911BB533A5' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.module.ts'; Hash = 'EAC856F951C93EC59FAA321A71BA1D787B3C55D9F866029FDE1B6C9B0A669E96' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.rules.ts'; Hash = '8BFBB66C580275B0D61FD7B0B223AE508D1E75807F06437239B2BFDC8A102512' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.service.ts'; Hash = '2D8E85DFBAF1454AF813556E7B8CAD16EF9BCD549111614002E35B53C1D50C66' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.sql.ts'; Hash = '87F0A5F98D888CCF096EFFE5E50B4414646F3ACAD572465BB2987E03E7F5EED1' }
  @{ Path = 'backend\src\attendance-stats\dto\attendance-stats-query.dto.ts'; Hash = '63397FE2A33DD7A93C80856E55D4427F85C69BCB8C7305E4A6487BF73D9EB57C' }
  @{ Path = 'backend\src\attendance-stats\meeting-days.spec.ts'; Hash = '71D05F348A716A569404772D5C04CD639B512B2577DC2ED094AB18C949427926' }
  @{ Path = 'backend\src\attendance-stats\meeting-days.ts'; Hash = '43489C5490F7225660550EDB7C133610E212354BF2DFB2EB950F320B0289397D' }
  @{ Path = 'backend\src\attendance\attendance-points.spec.ts'; Hash = 'CE8FACE77BF7E4EDE0666C601292FE399562EE637010B2BD6167B05DE61EDBD3' }
  @{ Path = 'backend\src\attendance\attendance.service.ts'; Hash = '1C81278AF209C1F38DEC606F530619E376895E1F2EC0C9BEB4E3DA549D97CBC0' }
  @{ Path = 'backend\src\attendance\dto\mark-attendance.dto.ts'; Hash = 'A10F8B9C2C00C6D5DCBDE99BF7229B888CF572DC5BC4AC3730BDFC5D97794244' }
  @{ Path = 'backend\src\terms\dto\create-term.dto.ts'; Hash = 'F2817ADD71F242221D2B66BA232AA80216D9D58A900F366B99FA20AB4FD7A180' }
  @{ Path = 'backend\src\terms\dto\update-term.dto.ts'; Hash = '0C9327895E8BEC46AD2EFF2D277C8F6772816DE0CCFB9F99D9AC581A362CBBD1' }
  @{ Path = 'backend\src\terms\meeting-days-input.spec.ts'; Hash = 'FB2353DB3B044D74731BCBBD0760B5F920DAD0F98FC0BDAE445558D314D134AE' }
  @{ Path = 'backend\src\terms\terms.service.ts'; Hash = 'A99DA87B2CD8076E1975F25D6304DB85458B42B5A354E28E26F8ED57ED10FE50' }
  @{ Path = 'lib\features\admin\presentation\screens\admin_home_screen.dart'; Hash = 'EE00F35ED1430AB1B0F435456DE8B201B035A4C88271BAD2CB2F70D7A124C548' }
)

$bad = 0
foreach ($f in $files) {
  $full = Join-Path $root $f.Path
  if (-not (Test-Path $full)) { Write-Host "MISSING   $($f.Path)" -ForegroundColor Red; $bad++; continue }
  $h = (Get-FileHash $full -Algorithm SHA256).Hash
  if ($h -eq $f.Hash) { Write-Host "OK        $($f.Path)" -ForegroundColor Green }
  else { Write-Host "MISMATCH  $($f.Path)" -ForegroundColor Red; $bad++ }
}
if ($bad -gt 0) { Write-Host "`n$bad file(s) differ — stop here." -ForegroundColor Red; exit 1 }
Write-Host "`nAll $($files.Count) files match.`n" -ForegroundColor Green

Push-Location (Join-Path $root 'backend')
try {
  npx prisma generate
  if ($LASTEXITCODE -ne 0) { throw 'prisma generate failed' }
  npx tsc -p tsconfig.build.json --noEmit
  if ($LASTEXITCODE -ne 0) { throw 'TypeScript build check failed' }
  npx jest src/attendance-stats src/attendance/attendance-points.spec.ts src/terms src/recitation src/points/course-isolation.spec.ts src/quran-metadata
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
} finally { Pop-Location }

Push-Location $root
try {
  flutter analyze lib/features/admin/presentation/screens/admin_home_screen.dart
  if ($LASTEXITCODE -ne 0) { throw 'flutter analyze reported problems' }
} finally { Pop-Location }

Write-Host "`n✓ Phase 1 verified: files, prisma client, TypeScript, tests, flutter analyze." -ForegroundColor Green
