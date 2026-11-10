; DSH-X 关窗后常驻托盘，升级/重装前要先让它退出。
;
; **不要用第三方进程插件**：实测 nsProcess 在部分环境（含干净系统）对不存在的
; 进程也返回“找到”，用户重启电脑后安装器照样弹“仍在运行”——检测链不可信。这里全部
; 改用系统自带的 PowerShell 进程计数（输出恒为数字，不受系统语言影响）和
; taskkill，行为可预期。优先 --dshx-quit 安全退出（新版外壳会停掉本机 DSH 后
; 自己退出）；旧版外壳不认识该参数，超时后自动强杀，不把用户挡在安装器外。

!define DSHX_PROC_NAME "DSH"

; 进程计数写入 _OUT（1=有，0=无）。$R2/$R3 是宏内部寄存器，别在外层挪用。
!macro DSHX_PROC_COUNT _OUT
  nsExec::ExecToStack `powershell -NoProfile -ExecutionPolicy Bypass -Command "@(Get-Process -Name '${DSHX_PROC_NAME}' -ErrorAction SilentlyContinue).Count"`
  Pop $R2
  Pop $R3
  ; 只信“命令成功（退出码 0）且输出 > 0”。ExecToStack 在命令起不来时会把
  ; 错误码字符串（如 0xc0000135）放进输出栈——直接比大小会把失败当“有进程”，
  ; 重现“没有 DSH 也弹在运行”。失败宁可放行：真有进程时文件占用自会兜底。
  ${If} $R2 == 0
  ${AndIf} $R3 U> 0
    StrCpy ${_OUT} 1
  ${Else}
    StrCpy ${_OUT} 0
  ${EndIf}
!macroend

; 统一默认安装位置。已有安装记录时 electron-builder 会先读 InstallLocation；
; 这里只处理“全新安装”：用户没有显式 /D 时默认 D:\dsh，避免下次清理注册表后
; 又落回 %LocalAppData%\Programs\DSH。
!macro customInit
  !insertmacro GetDParameter $R5
  ${If} $R5 == ""
    ReadRegStr $R6 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $R6 == ""
      StrCpy $INSTDIR "D:\dsh"
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ; 0.1.24 有一批“主程序被杀软/手工删掉、卸载器和注册表还在”的残缺安装。通用升级逻辑
  ; 会先复制旧卸载器并等它退出 0；这种残缺卸载器常返回 2，把修复安装也挡在门外。
  ; 这里只在主程序确实不存在时备份并移走旧 UninstallString，让 electron-builder 跳过
  ; 旧卸载器、继续按 INSTALL_REGISTRY_KEY 里的原目录覆盖修复。成功后本安装器会写回
  ; 新卸载信息；失败时旧卸载器文件仍在安装目录，可手动执行。
  ReadRegStr $R4 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R4 != ""
  ${AndIfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ReadRegStr $R5 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "BrokenUninstallString" $R4
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "BrokenDisplayVersion" $R5
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
    DetailPrint "Skipping broken old uninstaller (application executable is missing)..."
  ${EndIf}

  ; 这里绝不能用 Return 跳过“未运行”：customCheckAppRunning 被插入安装 Section，
  ; Return 会把整个安装流程提前结束，导致没有 DSH 进程时反而无法安装。
  !insertmacro DSHX_PROC_COUNT $R0
  ${If} $R0 == 1
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "DSH-X is running. Click OK to close it and continue.$\r$\n\
      检测到 DSH-X 正在运行。点击“确定”关闭它并继续安装。" \
      /SD IDOK

    DetailPrint "Safely exiting DSH-X..."
    nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --dshx-quit`
    Pop $R0

    ; 新版外壳停实例 + 12 秒硬退兜底；这里最多等 15 秒，之后不再等对方配合。
    StrCpy $R1 0
    ${Do}
      Sleep 1000
      !insertmacro DSHX_PROC_COUNT $R0
      ${If} $R0 == 0
        ${ExitDo}
      ${EndIf}
      IntOp $R1 $R1 + 1
      ${If} $R1 >= 15
        Goto dshxQuitForce
      ${EndIf}
    ${Loop}
    ; 进程退了 ≠ 文件能删：Windows 的程序兼容性助手（PCA）会在退出瞬间接管主 exe
    ; 做评估，Defender 也有 close-scan——句柄攥 1~5 秒不等，固定等待堵不住。
    ; 这里直接探测删除：删得动说明锁已放，后续卸载/复制才不会 Abort；删不动
    ; 就再等，超时走强杀再来一轮。删掉的主程序紧接着就会被新文件覆盖。
    StrCpy $R1 0
    ${Do}
      Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        ${ExitDo}
      ${EndIf}
      Sleep 1000
      IntOp $R1 $R1 + 1
      ${If} $R1 >= 15
        Goto dshxQuitForce
      ${EndIf}
    ${Loop}
    Goto dshxQuitDone

dshxQuitForce:
    DetailPrint "DSH-X did not exit in time, force stopping..."
    nsExec::Exec `taskkill /IM DSHNode.exe /F`
    Pop $R0
    nsExec::Exec `taskkill /IM DSH.exe /F`
    Pop $R0
    Sleep 2500
    !insertmacro DSHX_PROC_COUNT $R0
    ${If} $R0 == 1
      MessageBox MB_OK|MB_ICONSTOP \
        "DSH-X could not be closed. Please close it in Task Manager and run this installer again.$\r$\n\
        无法关闭 DSH-X，请在任务管理器中手动结束后重新运行安装程序。" \
        /SD IDOK
      Quit
    ${EndIf}

dshxQuitDone:
  ${EndIf}
!macroend

; dsh/npm/pnpm 子进程与外壳共用 Electron 本体；不加区分时它们也叫 DSH.exe，
; 外壳退出后残留一个，安装器就报“还在运行”。硬链接一份 DSHNode.exe 专供
; node 模式（ELECTRON_RUN_AS_NODE=1），同名卷零额外磁盘占用；失败则核心
; 回退用 DSH.exe，行为与旧版一致。
!macro customInstall
  Delete "$INSTDIR\DSHNode.exe"
  nsExec::Exec `cmd /c mklink /H "$INSTDIR\DSHNode.exe" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\DSHNode.exe"
!macroend
