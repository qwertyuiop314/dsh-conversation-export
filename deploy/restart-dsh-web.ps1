# restart-dsh-web.ps1 — 手动重启 dsh web 服务（供 重启DSH服务.bat 调用）
# 用法：双击 D:\workspace\重启DSH服务.bat，或在本文件上右键"使用 PowerShell 运行"
$ErrorActionPreference = 'SilentlyContinue'
Write-Host "== DSH Web 服务重启 =="

# 1) 找到线上 dsh web（端口 3080 的监听进程；失败则按命令行匹配）
$target = $null
$conn = Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object -First 1
if ($conn) { $target = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
if (-not $target) {
  $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*@deepseek-ai\dsh*bin.js*web*' } |
    Select-Object -First 1
  if ($proc) { $target = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue }
}
if (-not $target) {
  Write-Host "未找到运行中的 dsh web 服务（http://127.0.0.1:3080 没有在运行）。"
  Write-Host "如果服务根本没启动，直接运行: dsh web"
  exit 1
}

# 2) 停止旧服务
Write-Host ("正在停止旧服务 (PID " + $target.Id + ") ...")
Stop-Process -Id $target.Id -Force
Start-Sleep -Seconds 4

# 3) 启动新服务（后台运行，日志写入 .dsh 目录）
$node = 'C:\Program Files\nodejs\node.exe'
$bin  = 'C:\Users\USER\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
Start-Process -FilePath $node -ArgumentList ('"' + $bin + '"'), 'web' -WorkingDirectory 'D:\workspace' -WindowStyle Hidden `
  -RedirectStandardOutput 'C:\Users\USER\.dsh\web-restart.log' `
  -RedirectStandardError  'C:\Users\USER\.dsh\web-restart.err.log'

Write-Host ""
Write-Host "✔ 新服务已启动。请等待约 10~20 秒，然后刷新浏览器页面:"
Write-Host "   http://127.0.0.1:3080"
Write-Host '   刷新后，Session 页面右上角会出现蓝色"导出对话"按钮（在"Session log"左边）。'
Write-Host ""
Write-Host "如果页面打不开，请看日志: C:\Users\USER\.dsh\web-restart.err.log"
