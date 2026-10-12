Add-Type -AssemblyName System.Drawing
$root = Join-Path (Get-Location) '.cache/quality-optimization/author-trial'
$bmp = New-Object System.Drawing.Bitmap 1600,1000
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
function Brush($hex) { New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Font($size) { New-Object System.Drawing.Font 'Microsoft YaHei UI',$size,([System.Drawing.FontStyle]::Regular),([System.Drawing.GraphicsUnit]::Pixel) }
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#E7E9E3'))
$g.DrawString('布局草图 · 文字与画面位置试排 · 无真实素材',(Font 22),(Brush '#344C42'),64,27)
$g.FillRectangle((Brush '#F3F0E8'),0,100,1600,900)
$g.FillRectangle((Brush '#D7DFD0'),645,178,885,744)
$pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#AFBFAA')),2
$g.DrawLine($pen,645,178,1530,922)
$g.DrawLine($pen,1530,178,645,922)
$g.FillRectangle((Brush '#D7DFD0'),920,470,338,128)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('画面占位',(Font 30),(Brush '#47614F'),1088,484,$format)
$g.DrawString('真实素材待选',(Font 22),(Brush '#47614F'),1088,540,$format)
$g.FillRectangle((Brush '#C66F45'),88,358,54,8)
$g.DrawString('把读过的故事，',(Font 64),(Brush '#293F37'),88,389)
$g.DrawString('交给下一个人',(Font 64),(Brush '#293F37'),88,482)
$accent = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#C66F45')),5
$g.DrawLine($accent,90,586,468,586)
$bmp.Save((Join-Path $root '04-旧书交换-布局草图.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
