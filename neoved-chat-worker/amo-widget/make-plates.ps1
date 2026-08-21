# Рисует «плашки» логотипа — те картинки, которые amoCRM показывает строкой
# в панели виджетов: сплошной красный фон и белая надпись «neoved чат».
#
# Почему PowerShell, а не node, как остальные генераторы: нарисовать текст в
# PNG без шрифтовых библиотек нельзя, а System.Drawing из .NET умеет это с
# настоящим системным шрифтом.
#
# Файл сохранён в UTF-8 с BOM: без него Windows PowerShell 5.1 читает его как
# ANSI и русские строки превращаются в мусор.
#
# Запуск: powershell -ExecutionPolicy Bypass -File .\make-plates.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Set-Location $PSScriptRoot

$red = [Drawing.Color]::FromArgb(238, 0, 0)
$white = [Drawing.Color]::White

function New-Plate {
    param(
        [int]$Width,
        [int]$Height,
        [string[]]$Lines,
        [single]$FontSize,
        [string]$File
    )

    $bmp = New-Object Drawing.Bitmap $Width, $Height
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear($red)

    $font = New-Object Drawing.Font 'Segoe UI Semibold', $FontSize, ([Drawing.FontStyle]::Regular), ([Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object Drawing.SolidBrush $white
    $format = New-Object Drawing.StringFormat
    $format.Alignment = [Drawing.StringAlignment]::Center
    $format.LineAlignment = [Drawing.StringAlignment]::Center

    # Пузырь чата слева от текста — только на широкой плашке, на узкой он
    # съедает место под надпись.
    $text = [string]::Join("`n", $Lines)
    $textBox = New-Object Drawing.RectangleF 0, 0, $Width, $Height
    if ($Width -ge 200) {
        $bubbleSize = [int]($Height * 0.38)
        $bubbleX = [int]($Width * 0.10)
        $bubbleY = [int](($Height - $bubbleSize) / 2)
        $g.FillEllipse($brush, $bubbleX, $bubbleY, $bubbleSize, $bubbleSize)

        # Хвостик пузыря
        $tail = New-Object Drawing.Drawing2D.GraphicsPath
        $tail.AddPolygon(@(
            (New-Object Drawing.Point ($bubbleX + [int]($bubbleSize * 0.22)), ($bubbleY + $bubbleSize - 2)),
            (New-Object Drawing.Point ($bubbleX + [int]($bubbleSize * 0.55)), ($bubbleY + $bubbleSize - 2)),
            (New-Object Drawing.Point ($bubbleX + [int]($bubbleSize * 0.20)), ($bubbleY + $bubbleSize + [int]($bubbleSize * 0.30)))
        ))
        $g.FillPath($brush, $tail)
        $tail.Dispose()

        $textBox = New-Object Drawing.RectangleF ($bubbleX + $bubbleSize), 0, ($Width - $bubbleX - $bubbleSize - 8), $Height
    }

    $g.DrawString($text, $font, $brush, $textBox, $format)

    $g.Dispose()
    $path = Join-Path $PSScriptRoot "images\$File"
    $bmp.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "images/$File — ${Width}x${Height}"
}

New-Plate -Width 240 -Height 84 -Lines @('neoved чат') -FontSize 24 -File 'logo_medium.png'
New-Plate -Width 130 -Height 100 -Lines @('neoved', 'чат') -FontSize 20 -File 'logo.png'
New-Plate -Width 400 -Height 272 -Lines @('neoved чат') -FontSize 44 -File 'logo_main.png'
