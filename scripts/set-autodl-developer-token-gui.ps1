[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$codexRoot = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
if ([string]::IsNullOrWhiteSpace($codexRoot)) {
    $codexRoot = Join-Path $env:USERPROFILE '.codex'
}

$secretDir = Join-Path $codexRoot 'secrets'
$secretFile = Join-Path $secretDir 'autodl-developer.token'

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'AutoDL Developer Token（安全授权）'
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Width = 620
$form.Height = 285
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 10)

$title = [System.Windows.Forms.Label]::new()
$title.Text = '粘贴 AutoDL Developer Token'
$title.Font = [System.Drawing.Font]::new('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Left = 24
$title.Top = 22
$form.Controls.Add($title)

$help = [System.Windows.Forms.Label]::new()
$help.Text = "获取位置：AutoDL 控制台 → 账号 → 设置 → 开发者 Token`r`nToken 只会以当前 Windows 用户的 DPAPI 密文保存，不进入聊天、日志或数据库。"
$help.AutoSize = $true
$help.Left = 24
$help.Top = 62
$form.Controls.Add($help)

$input = [System.Windows.Forms.TextBox]::new()
$input.Left = 24
$input.Top = 116
$input.Width = 555
$input.UseSystemPasswordChar = $true
$input.ShortcutsEnabled = $true
$form.Controls.Add($input)

$status = [System.Windows.Forms.Label]::new()
$status.AutoSize = $true
$status.Left = 24
$status.Top = 153
$status.ForeColor = [System.Drawing.Color]::Firebrick
$form.Controls.Add($status)

$save = [System.Windows.Forms.Button]::new()
$save.Text = '加密保存并继续'
$save.Left = 385
$save.Top = 183
$save.Width = 194
$save.Height = 38
$form.AcceptButton = $save
$form.Controls.Add($save)

$save.Add_Click({
    try {
        $token = $input.Text.Trim()
        if ($token.Length -lt 8) {
            $status.Text = 'Token 为空或过短，尚未保存。'
            return
        }

        New-Item -ItemType Directory -Path $secretDir -Force | Out-Null
        $secureToken = ConvertTo-SecureString -String $token -AsPlainText -Force
        $encrypted = ConvertFrom-SecureString -SecureString $secureToken
        $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($secretFile, $encrypted, $utf8NoBom)

        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetOwner($identity)
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $identity,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $secretFile -AclObject $acl

        $input.Clear()
        [System.Windows.Forms.MessageBox]::Show(
            'Developer Token 已加密保存。系统将继续执行实例识别、自动开机和视频验收。',
            '保存成功',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Close()
    }
    catch {
        $input.Clear()
        $status.Text = '保存失败，请重新粘贴。Token 未写入日志。'
    }
})

$form.Add_Shown({ $input.Focus() })
[void]$form.ShowDialog()
