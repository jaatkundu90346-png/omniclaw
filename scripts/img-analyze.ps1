param([string]$ImagePath)
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile($ImagePath)
Write-Output ("SIZE: {0}x{1}" -f $bmp.Width, $bmp.Height)

# Brightness map (ASCII): '#'=dark, '.'=bright, '+'=mid, letters hint dominant hue
$stepX = [Math]::Max(1, [int]($bmp.Width / 80))
$stepY = [Math]::Max(1, [int]($bmp.Height / 40))
for ($y = 0; $y -lt $bmp.Height; $y += $stepY) {
  $row = ""
  for ($x = 0; $x -lt $bmp.Width; $x += $stepX) {
    $c = $bmp.GetPixel($x, $y)
    $lum = ($c.R + $c.G + $c.B) / 3
    $maxc = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
    $minc = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
    $sat = if ($maxc -eq 0) { 0 } else { ($maxc - $minc) / $maxc }
    if ($sat -gt 0.5 -and $maxc -gt 100) {
      if ($c.R -eq $maxc) { $row += "R" }
      elseif ($c.G -eq $maxc) { $row += "G" }
      elseif ($c.B -eq $maxc) { $row += "B" }
      else { $row += "?" }
    }
    elseif ($lum -lt 60) { $row += "#" }
    elseif ($lum -gt 210) { $row += "." }
    else { $row += "+" }
  }
  Write-Output $row
}

# Dominant color buckets
$buckets = @{}
for ($y = 0; $y -lt $bmp.Height; $y += 8) {
  for ($x = 0; $x -lt $bmp.Width; $x += 8) {
    $c = $bmp.GetPixel($x, $y)
    $key = "{0},{1},{2}" -f ([int]($c.R/64)), ([int]($c.G/64)), ([int]($c.B/64))
    if (-not $buckets.ContainsKey($key)) { $buckets[$key] = 0 }
    $buckets[$key]++
  }
}
Write-Output "`nTOP COLOR BUCKETS (r/64,g/64,b/64 : count):"
$buckets.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object {
  Write-Output ("  {0}: {1}" -f $_.Key, $_.Value)
}
$bmp.Dispose()
