# Opens the generated .docx in Word, fills in the table of contents, saves it, and exports a PDF
# next to it. Needs Microsoft Word. Progress goes to update_toc.log in the temp folder.
#   powershell -ExecutionPolicy Bypass -File update_toc.ps1
#
# Written step by step on purpose. Variants of this script hung Word with no visible dialog: a
# blanket Fields.Update(), a "~"-prefixed temp name, and ComputeStatistics() before SaveAs2.
$root = Split-Path -Parent $PSScriptRoot
$Docx = Join-Path $root "FROSTMIND_Phase7_Documentation.docx"
$Pdf = Join-Path $root "FROSTMIND_Phase7_Documentation.pdf"
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "frostmind_toc_test.docx")
$tmpPdf = [IO.Path]::Combine([IO.Path]::GetTempPath(), "frostmind_toc_test.pdf")
$Log = [IO.Path]::Combine([IO.Path]::GetTempPath(), "update_toc.log")

"" | Set-Content $Log
function L($m) { Add-Content $Log ("{0:N1}s {1}" -f $sw.Elapsed.TotalSeconds, $m) }
$sw = [Diagnostics.Stopwatch]::StartNew()
Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $root "~`$OSTMIND_Phase7_Documentation.docx"), $tmp, $tmpPdf
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
L "word started"
$doc = $word.Documents.Open($Docx, $false, $false)
L "opened (read-write)"
$doc.Repaginate(); L "repaginated"
$doc.TablesOfContents.Item(1).Update(); L "toc updated"
$doc.SaveAs2($tmp, 16); L "saved as $tmp"
$doc.ExportAsFixedFormat($tmpPdf, 17); L "exported pdf"
# Word sometimes drops the COM connection while closing; the files are already written by then.
try { $doc.Close(0); $word.Quit() } catch { L "close: $($_.Exception.Message)" }
Get-Process WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
L "word closed"
Copy-Item -Force $tmp $Docx
Copy-Item -Force $tmpPdf $Pdf
L "done"
Write-Output "TOC updated and PDF exported"
