[CmdletBinding()]
param([ValidateSet('domestic','international')][string]$Environment='domestic')
$ErrorActionPreference='Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$entry=Join-Path $root '99_系统协议\02_操作协议\Infisical\登记-新凭据-本机安全引导.ps1'
if(-not (Test-Path -LiteralPath $entry -PathType Leaf)){throw 'REGISTERED_CREDENTIAL_ENTRY_MISSING'}
& $entry -Environment development -SourceId windows-controlled-credentials -LogicalName ('aitoearn-'+$Environment+'-api-key') -Purpose '自媒体操盘手站方发布API；仅本机DPAPI受控读取，不复制给会员'
