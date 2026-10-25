# ═══════════════════════════════════════════════════════════════════════════
# verify-instructor-stats.ps1 — attendance work check (phases 1, 2, 2b, 3, 3b).
#
# Confirms every file of the attendance deliverable on disk is byte-identical
# to what was tested, then: prisma client, TypeScript build, backend tests,
# and flutter analyze.  Read-only: changes no source file, touches no
# database (prisma generate only writes node_modules).
#
# Usage (from D:\taqwa-app\taqwa_mobile):
#   powershell -ExecutionPolicy Bypass -File .\backend\scripts\verify-instructor-stats.ps1
# ═══════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$files = @(
  @{ Path = 'backend\prisma\migrations\20261022000000_attendance_foundation\migration.sql'            ; Hash = 'AD858F945D9F520767E869FDD47567040AD0B5CE387BE4EC8713C9E9FF8DF455' }
  @{ Path = 'backend\prisma\migrations\20261023000000_halaqa_coverage\migration.sql'                  ; Hash = '4EC161C94FAE4BC3CF6DC19505EE268A20500E5FADFEB13D0497EF15E2DE721B' }
  @{ Path = 'backend\prisma\migrations\20261024000000_supervisor_role\migration.sql'                  ; Hash = '6E98917FD5D978E7C11A6BD3685138443793F091669B688759CC3AA741220B0C' }
  @{ Path = 'backend\prisma\schema.prisma'                                                            ; Hash = '3F0C991DF21F6E10900947BF0D5B827316D64BE6B6714CC24DA6FC466ADE06F5' }
  @{ Path = 'backend\src\app.module.ts'                                                               ; Hash = '50717346FD808EAEE3FD03B512D48B55EF79C5985942E3798466E30B86F122EC' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.controller.ts'                             ; Hash = 'CB198F3DFB93A9A01C7C32F8DA4B606F542B8FD7FF5E5E2F3F7420D55C30C479' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.module.ts'                                 ; Hash = 'EAC856F951C93EC59FAA321A71BA1D787B3C55D9F866029FDE1B6C9B0A669E96' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.rules.ts'                                  ; Hash = '8BFBB66C580275B0D61FD7B0B223AE508D1E75807F06437239B2BFDC8A102512' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.service.ts'                                ; Hash = '2D8E85DFBAF1454AF813556E7B8CAD16EF9BCD549111614002E35B53C1D50C66' }
  @{ Path = 'backend\src\attendance-stats\attendance-stats.sql.ts'                                    ; Hash = '87F0A5F98D888CCF096EFFE5E50B4414646F3ACAD572465BB2987E03E7F5EED1' }
  @{ Path = 'backend\src\attendance-stats\dto\attendance-stats-query.dto.ts'                          ; Hash = '63397FE2A33DD7A93C80856E55D4427F85C69BCB8C7305E4A6487BF73D9EB57C' }
  @{ Path = 'backend\src\attendance-stats\meeting-days.spec.ts'                                       ; Hash = '71D05F348A716A569404772D5C04CD639B512B2577DC2ED094AB18C949427926' }
  @{ Path = 'backend\src\attendance-stats\meeting-days.ts'                                            ; Hash = '43489C5490F7225660550EDB7C133610E212354BF2DFB2EB950F320B0289397D' }
  @{ Path = 'backend\src\attendance\attendance-points.spec.ts'                                        ; Hash = 'CE8FACE77BF7E4EDE0666C601292FE399562EE637010B2BD6167B05DE61EDBD3' }
  @{ Path = 'backend\src\attendance\attendance-sheet.spec.ts'                                         ; Hash = '4E25142094692518BBE4ABDB6CDC68DE8C92000147334EC87B7DB5B6A9312D16' }
  @{ Path = 'backend\src\attendance\attendance.service.ts'                                            ; Hash = '8C14090D0E4901BF1AD5EDB132361C4F697FA1D07E5F2001D40DFCBF86B7B173' }
  @{ Path = 'backend\src\attendance\dto\mark-attendance.dto.ts'                                       ; Hash = 'A10F8B9C2C00C6D5DCBDE99BF7229B888CF572DC5BC4AC3730BDFC5D97794244' }
  @{ Path = 'backend\src\points\points.controller.ts'                                                 ; Hash = '2014995538D1ACE1D93AD69295CAC097B9F7170EF0055A7072906238318790DA' }
  @{ Path = 'backend\src\recitation\recitation.controller.ts'                                         ; Hash = '767681E963880F5533FEE1C79148351352457BBA44CBC0E8B667FF92330F8911' }
  @{ Path = 'backend\src\students\students.controller.ts'                                             ; Hash = '35A6CB9E76791D35BBF268B4EC88F3FEEEA1587EAFB0DCCD038674D7D10E1DA7' }
  @{ Path = 'backend\src\substitute\dto\substitute.dto.ts'                                            ; Hash = '0D62845EDF8F6EA77F5D525C572A23ACC2BC3F405117E49BE7ED66FF8BE2BBBC' }
  @{ Path = 'backend\src\substitute\substitute.controller.ts'                                         ; Hash = '9FED4915DCDB3767C02363DB24F10AAC77C8ECB7A6033D3FEFBDDA3F537D846F' }
  @{ Path = 'backend\src\substitute\substitute.module.ts'                                             ; Hash = 'EE8F8AB50254B3178F48F187B50048C5177AEB47B1209BEF0E37AB9B1CA8D3D9' }
  @{ Path = 'backend\src\substitute\substitute.service.ts'                                            ; Hash = '23E38E7337303AAC755CA9AE2B4645E333F3FE07F0AE3A369C252ECFFED0DDAE' }
  @{ Path = 'backend\src\substitute\substitute.spec.ts'                                               ; Hash = '43ACD4CFA64258DB9AA188519999B449F13867A3C920D8209104398FAA9790E9' }
  @{ Path = 'backend\src\supervisor\dto\supervisor-account.dto.ts'                                    ; Hash = '101FF87ED4CA22E3D6BF6062950044954E75E3C53833A12E3DDCBCCE7363D8E8' }
  @{ Path = 'backend\src\supervisor\dto\supervisor-query.dto.ts'                                      ; Hash = 'F3940A618A71CF85C5308537A05697EE058C455AA7765F55F7D20DC309237AD2' }
  @{ Path = 'backend\src\supervisor\meeting-calendar.ts'                                              ; Hash = 'E87CE1B523238C9E845BAE74480624360C532C5B806485A2E5628BB28AE8A9A7' }
  @{ Path = 'backend\src\supervisor\supervisor-detail.service.ts'                                     ; Hash = 'E3D649A589515887FFBD18BBA8C92AEF4A40433BD922F7A149457614643C0FC0' }
  @{ Path = 'backend\src\supervisor\supervisor-detail.spec.ts'                                        ; Hash = '6B1C6BDD5D088D6C1AC926B4DDBB1F9FB7E8A6A74B274E7159CDB8738F9DAF8C' }
  @{ Path = 'backend\src\supervisor\supervisor.controller.ts'                                         ; Hash = '39874FBF83596117F16923E600811584D5BC3DA0F5779877A65D6F584BC30F63' }
  @{ Path = 'backend\src\supervisor\supervisor.module.ts'                                             ; Hash = 'F13E185D25CDB4F1909D5B47B6F6679D777939775422E74C7BA14994D3C7D738' }
  @{ Path = 'backend\src\supervisor\supervisor.service.ts'                                            ; Hash = '6FD7960C3AF000F3ECED8FE243DBA4F5AEFB04DEA53131CF42E968654C0D6AFB' }
  @{ Path = 'backend\src\supervisor\supervisor.spec.ts'                                               ; Hash = '25F47CA658B86B61EA9B0DC4A4BEC415FD5CB84836456F21214EA855FCB1A396' }
  @{ Path = 'backend\src\supervisor\supervisor.sql.ts'                                                ; Hash = 'EF7E97EB83ABE125958CD77F22BBA82B24E283799EDAA61E996349A26550C1CD' }
  @{ Path = 'backend\src\terms\dto\create-term.dto.ts'                                                ; Hash = 'F2817ADD71F242221D2B66BA232AA80216D9D58A900F366B99FA20AB4FD7A180' }
  @{ Path = 'backend\src\terms\dto\update-term.dto.ts'                                                ; Hash = '0C9327895E8BEC46AD2EFF2D277C8F6772816DE0CCFB9F99D9AC581A362CBBD1' }
  @{ Path = 'backend\src\terms\meeting-days-input.spec.ts'                                            ; Hash = 'FB2353DB3B044D74731BCBBD0760B5F920DAD0F98FC0BDAE445558D314D134AE' }
  @{ Path = 'backend\src\terms\terms.service.ts'                                                      ; Hash = 'A99DA87B2CD8076E1975F25D6304DB85458B42B5A354E28E26F8ED57ED10FE50' }
  @{ Path = 'lib\core\utils\meeting_days.dart'                                                        ; Hash = 'C8A6D89AB3E40736FFE9DD84170C7ACF4F9489BAF5EAD91EC5FEA1BC520A8D9E' }
  @{ Path = 'lib\features\admin\presentation\screens\admin_home_screen.dart'                          ; Hash = '14E57C848137FC23179794B2A2CA50D314543E512E4BEC39C87006647E0D4146' }
  @{ Path = 'lib\features\attendance\data\models\attendance_sheet_model.dart'                         ; Hash = 'ADBBF96B89025531C522CC186A807F7A7E0189FD36ABE1DEF4F1356DC655BA04' }
  @{ Path = 'lib\features\attendance\presentation\providers\attendance_provider.dart'                 ; Hash = 'D363B7AFBA9DD7BDBF782B1560ACD513ECFB42C0FED9428B3C826B5ABE481515' }
  @{ Path = 'lib\features\attendance\presentation\screens\attendance_screen.dart'                     ; Hash = '7D6A2AA36675D1D4A2BEF94E3B5300A9256A2B6E9AF316146178C72CEA50C7BC' }
  @{ Path = 'lib\features\attendance_stats\data\attendance_stats_api.dart'                            ; Hash = '50DC77C0BF6061498B0BAD5F5201462C56839162CA6E1D12E0034D80205AED4A' }
  @{ Path = 'lib\features\attendance_stats\data\attendance_stats_models.dart'                         ; Hash = '9E25AD13D43602427651BB2ADD31BD169D23C9DA0EBB10678F599F6A80AA435B' }
  @{ Path = 'lib\features\attendance_stats\presentation\attendance_ui.dart'                           ; Hash = 'AC8F90E6F855A7DE4AA9554525F30B299D1DE44BE577ED738681EEE98E4DEE94' }
  @{ Path = 'lib\features\attendance_stats\presentation\widgets\student_attendance_view.dart'         ; Hash = '483DCB9F1C6E4707F8DC323F742B7B675401F72CCCAC85272C98E4B5B8614219' }
  @{ Path = 'lib\features\auth\domain\enums\user_role.dart'                                           ; Hash = '5CF2024140CEA9A28CCDECBA62B95CF4D5694428D9C3B75D8BE4BDE7D73B3069' }
  @{ Path = 'lib\features\instructor_home\presentation\screens\halaqa_attendance_screen.dart'         ; Hash = '7459FDDB65C575D35DEEDC051179FC0ECEA48AA78E27F032D1FD9DFFE31F2440' }
  @{ Path = 'lib\features\instructor_home\presentation\screens\instructor_dashboard_screen.dart'      ; Hash = '5CADF851D19B2FD3B9308D65CF307E1CBEE35783838070C61A760BE8AE9E634E' }
  @{ Path = 'lib\features\instructor_home\presentation\screens\instructor_student_detail_screen.dart' ; Hash = '3D60DC9510DAE2A67FE617A7F31BB5AF172E3047AD70B7CE9A193B20457E4A55' }
  @{ Path = 'lib\features\instructor_home\presentation\screens\maqraa_screen.dart'                    ; Hash = 'A41982175D17FEDB2BD45405CB9416478604FA39F099517B5D7E36A5149116DE' }
  @{ Path = 'lib\features\instructor_home\presentation\widgets\last_session_card.dart'                ; Hash = '0B42F9C034ED6F23042865CBADB2EC78BE73D048244F74AA4062332CBA01E975' }
  @{ Path = 'lib\features\substitute\data\substitute_api.dart'                                        ; Hash = '49A2C02B4388966DFBFC76D268DA3B52454D571E0E89FCF47F4F44ED547FD76A' }
  @{ Path = 'lib\features\substitute\data\substitute_models.dart'                                     ; Hash = '905D531711D5810CBBAF105E8AC9E815BACBADE4A3679EBF6876554E94FA82D6' }
  @{ Path = 'lib\features\substitute\presentation\screens\other_halaqas_screen.dart'                  ; Hash = '38B99DF6C96A3C3BDBCC4A1A3BAD28283C0EFD6628E6BAFB4539A0F1046420BB' }
  @{ Path = 'lib\features\substitute\presentation\substitute_ui.dart'                                 ; Hash = '8AFF064A6237CBA08F0D6F6351EE831BD29CEE16C85D35101BAC5291741BD7FA' }
  @{ Path = 'lib\features\supervisor\data\supervisor_api.dart'                                        ; Hash = '4449FECFDA2C0236B488E31BDC0B12826D333FAE04FAA935EEB585417D7FB428' }
  @{ Path = 'lib\features\supervisor\data\supervisor_models.dart'                                     ; Hash = '0EFF1F8076EB84B212E828CD098F7DC7DB0DDF31C170791D084E0FA5FD542851' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_accounts_screen.dart'            ; Hash = '1D031E08BEC3C4E639C6B06C06627665F261046925C486E6D27F40EE9B3006E4' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_day_tab.dart'                    ; Hash = '24FADACB896D20219DF9E0BBE16E998DAAB553DF79372C32C693FF303DE87BF2' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_halaqa_screen.dart'              ; Hash = '74512F0D2DC4A7082ACFC3CB0E41EAF6923383939A6C77DD3158241B2EC515AF' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_home_screen.dart'                ; Hash = '0CF9576BF77694FA94B55F1A54B00E8914D3B4287B2CEA426D408FCBA35A70F8' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_instructor_screen.dart'          ; Hash = 'F36AB0B12F60CF2DABFEAEB4DFD2850B6BCB097B7B5A3285AD87A3CD70E06AC6' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_instructors_tab.dart'            ; Hash = 'D3231C4F33B7A2047014B27213781228AED6AEBD30EA05CD386535EE33F730EF' }
  @{ Path = 'lib\features\supervisor\presentation\screens\supervisor_students_tab.dart'               ; Hash = '6A25234072446B3903E658E4F9BA6AC224173B1411A810AD8E200798BFE649B0' }
  @{ Path = 'lib\features\supervisor\presentation\supervisor_navigation.dart'                         ; Hash = 'FF4E8C6CD981661ACCACD45E7BA837687A69DA25E0F2976E60B7D88D5E72F918' }
  @{ Path = 'lib\features\supervisor\presentation\supervisor_ui.dart'                                 ; Hash = 'C4BAB9A5A001F8D16830DB7348F2DC5D50BF6CBD4ACD742C5EF46225116A32C7' }
  @{ Path = 'lib\features\terms\data\term_model.dart'                                                 ; Hash = '308F8FFE85649035BABA43414E27771A28D31C5A616016FBCEF2AAD00B4D1163' }
  @{ Path = 'lib\main.dart'                                                                           ; Hash = 'BC35DB060B1753067B43BA894E8FC0725EF138DC666229D1AD0D293E444D9FFC' }
  @{ Path = 'pubspec.yaml'                                                                            ; Hash = '67B714026A55FB5934B92D4FCCB1F34203CFBC525B1F67EE444A99B7CB9CE43F' }
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
  npx jest src/attendance-stats src/attendance/attendance-points.spec.ts src/attendance/attendance-sheet.spec.ts src/substitute src/supervisor src/terms src/recitation src/points/course-isolation.spec.ts src/quran-metadata
  if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
} finally { Pop-Location }

Push-Location $root
try {
  # 1) The new and rewritten Dart files must be completely clean.
  flutter analyze `
    lib/core/utils/meeting_days.dart `
    lib/features/admin/presentation/screens/admin_home_screen.dart `
    lib/features/auth/domain/enums/user_role.dart `
    lib/features/attendance/data/models/attendance_sheet_model.dart `
    lib/features/attendance/presentation/providers/attendance_provider.dart `
    lib/features/attendance/presentation/screens/attendance_screen.dart `
    lib/features/attendance_stats/data/attendance_stats_api.dart `
    lib/features/attendance_stats/data/attendance_stats_models.dart `
    lib/features/attendance_stats/presentation/attendance_ui.dart `
    lib/features/attendance_stats/presentation/widgets/student_attendance_view.dart `
    lib/features/instructor_home/presentation/screens/halaqa_attendance_screen.dart `
    lib/features/instructor_home/presentation/screens/maqraa_screen.dart `
    lib/features/instructor_home/presentation/widgets/last_session_card.dart `
    lib/features/substitute `
    lib/features/supervisor `
    lib/features/terms/data/term_model.dart
  if ($LASTEXITCODE -ne 0) { throw 'flutter analyze reported problems in the attendance files' }

  # 2) The whole app (lib) must compile: no errors anywhere. Older hints in
  #    untouched code are listed but do not fail this step. test\ is left out:
  #    its template widget_test.dart predates the app and never compiled.
  flutter analyze --no-fatal-infos --no-fatal-warnings lib
  if ($LASTEXITCODE -ne 0) { throw 'flutter analyze found errors in lib' }
} finally { Pop-Location }

Write-Host "`n✓ Verified phases 1 + 2 + 2b + 3 + 3b: files, prisma client, TypeScript, tests, flutter analyze." -ForegroundColor Green
