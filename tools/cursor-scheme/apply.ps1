# ZFSN cursor scheme - apply cursors without signing out.
#
# Calls SystemParametersInfo(SPI_SETCURSORS) so the registry values written
# by install.bat take effect immediately, instead of waiting for next logon.
#
# Kept in its own .ps1 on purpose: embedding this as a one-liner inside a
# .bat forces backslash-escape juggling between cmd and PowerShell quoting
# rules, which mangles the generated C# (that is exactly how it broke once).

$ErrorActionPreference = 'Stop'

# SPI_SETCURSORS = 0x57, SPIF_UPDATEINIFILE = 0x01, SPIF_SENDCHANGE = 0x02
$SPI_SETCURSORS   = 0x57
$SPIF_UPDATE_SEND = 0x03

# Single-quoted here-string: no variable expansion, no escape processing.
$sig = @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SystemParametersInfo(
    uint uAction, uint uParam, System.IntPtr lpvParam, uint fuWinIni);
'@

try {
    $t = Add-Type -MemberDefinition $sig -Name ZFSN_SPI -Namespace ZFSN -PassThru
    $ok = $t::SystemParametersInfo($SPI_SETCURSORS, 0, [System.IntPtr]::Zero, $SPIF_UPDATE_SEND)
    if (-not $ok) {
        Write-Host "[!] SystemParametersInfo returned false."
        Write-Host "    Sign out and back in to apply the cursors."
        exit 1
    }
    Write-Host "[OK] Cursors applied."
    exit 0
}
catch {
    Write-Host ("[!] Apply failed: " + $_.Exception.Message)
    Write-Host "    Sign out and back in to apply the cursors."
    exit 1
}
