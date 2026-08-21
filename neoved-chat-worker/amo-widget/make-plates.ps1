# Рисует все логотипы виджета — сплошные красные плашки с белой надписью
# «neoved виджет», как синяя строка Zoom в панели виджетов amoCRM.
#
# Виджету нужен полный комплект из пяти картинок, иначе amoCRM показывает в
# панели пустую строку без названия и значка. Размеры жёсткие, взяты из
# документации Kommo «Widget images» (developers.kommo.com/docs/images):
#
#   logo_min.png     84x84   строка в карточке, свёрнутое состояние
#   logo_medium.png 240x84   строка в карточке, развёрнутое состояние
#   logo.png        130x100  страница настроек виджета
#   logo_small.png  108x108  страница настроек виджета
#   logo_main.png   400x272  страница настроек виджета
#
# Каждый файл — не больше 300 КБ.
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

    # Текст занимает всю плашку, оставляя лишь небольшие поля по краям.
    $pad = [Math]::Max(4, [int]($Width * 0.04))
    $box = New-Object Drawing.RectangleF $pad, 0, ($Width - $pad * 2), $Height
    $g.DrawString([string]::Join("`n", $Lines), $font, $brush, $box, $format)

    $g.Dispose()
    $bmp.Save((Join-Path $PSScriptRoot "images\$File"), [Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "images/$File - ${Width}x${Height}"
}

New-Plate -Width 240 -Height 84  -Lines @('neoved виджет')  -FontSize 30 -File 'logo_medium.png'
New-Plate -Width 130 -Height 100 -Lines @('neoved', 'виджет') -FontSize 22 -File 'logo.png'
New-Plate -Width 400 -Height 272 -Lines @('neoved', 'виджет') -FontSize 58 -File 'logo_main.png'
New-Plate -Width 108 -Height 108 -Lines @('neoved', 'виджет') -FontSize 18 -File 'logo_small.png'
New-Plate -Width 84  -Height 84  -Lines @('neoved', 'виджет') -FontSize 14 -File 'logo_min.png'
