# Streams the current system media session (GlobalSystemMediaTransportControls) as one JSON line per change.
param([string]$artDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(3000)) { return $null }
  $task.Result
}
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
# PowerShell cannot bind WinRT streams to .NET overloads directly; reflection does the cast.
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1
$Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($Manager::RequestAsync()) $Manager
$lastKey = ''
$tick = 0
$lastTrack = ''
$art = ''
while ($true) {
  $payload = @{ active = $false }
  try {
    $s = $mgr.GetCurrentSession()
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $Props
      $info = $s.GetPlaybackInfo()
      $tl = $s.GetTimelineProperties()
      $track = "$($p.Title)|$($p.Artist)"
      if ($track -ne $lastTrack) {
        $lastTrack = $track
        $art = ''
        if ($p.Thumbnail -and $artDir) {
          try {
            $stream = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
            if ($stream) {
              $net = $asStream.Invoke($null, @($stream))
              $ms = New-Object System.IO.MemoryStream
              $net.CopyTo($ms); $net.Close()
              $bytes = $ms.ToArray()
              $ext = if ($bytes.Length -gt 3 -and $bytes[0] -eq 0x89) { '.png' } else { '.jpg' }
              Get-ChildItem -LiteralPath $artDir -Filter 'art-*' -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue
              $file = Join-Path $artDir ("art-" + [Math]::Abs($track.GetHashCode()) + $ext)
              [System.IO.File]::WriteAllBytes($file, $bytes)
              $art = $file
            }
          } catch { $art = '' }
        }
      }
      $payload = @{
        active   = $true
        title    = "$($p.Title)"
        artist   = "$($p.Artist)"
        album    = "$($p.AlbumTitle)"
        app      = "$($s.SourceAppUserModelId)"
        playing  = ("$($info.PlaybackStatus)" -eq 'Playing')
        position = $tl.Position.TotalSeconds
        duration = ($tl.EndTime - $tl.StartTime).TotalSeconds
        art      = $art
      }
    }
  } catch {
    $payload = @{ active = $false; error = "$_" }
  }
  # Position moves every second; the dock extrapolates it, so resend only on changes or every 5 s.
  $key = ($payload.GetEnumerator() | Where-Object { $_.Key -ne 'position' } | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ';'
  $tick++
  if ($key -ne $lastKey -or $tick % 5 -eq 0) {
    $lastKey = $key
    [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1000
}
