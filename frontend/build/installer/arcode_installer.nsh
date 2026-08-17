; Custom NSIS script for Arcode installation detail output and progress text.

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  ; electron-builder expands this hook after common.nsh, whose default is
  ; "nevershow". Keep the log collapsed while exposing the native Show details
  ; control on the assisted installer page, matching the ArcRho installer so
  ; the observer's Show/Hide details button-reuse trick has a real toggle to
  ; drive (NSIS wires no click behavior for that control once the log is
  ; forced open with ShowInstDetails show).
  !macro customHeader
    ShowInstDetails hide
  !macroend

  !macro Arcode_PrintInstallDetail MSG
    ; Keep action-level output in the details list so it cannot replace the
    ; bar-derived percentage and time estimate in the status caption.
    SetDetailsPrint listonly
    DetailPrint "${MSG}"
  !macroend
!endif

ShowUninstDetails show

!macro preInit
  SetDetailsPrint both
!macroend

!macro customInit
  SetDetailsPrint both
  ${IfNot} ${Silent}
    ; Run progress observation outside the NSIS interpreter so file-copy work
    ; cannot block percentage updates on the installer page.
    InitPluginsDir
    File /oname=$PLUGINSDIR\ArcRhoInstallerProgress.exe "${PROJECT_DIR}\build\generated\ArcRhoInstallerProgress.exe"
  ${EndIf}
  DetailPrint "===== Installing Arcode ====="
  DetailPrint "Preparing installation..."
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW Arcode_InstFiles_Show
  !macroend

  Function Arcode_InstFiles_Show
    !insertmacro Arcode_PrintInstallDetail "Installer progress monitoring started."
    !insertmacro Arcode_PrintInstallDetail "Preparing destination and installing Arcode files..."
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    GetDlgItem $2 $0 1006
    GetDlgItem $4 $0 1016
    GetDlgItem $5 $0 1027
    ${If} $1 == 0
    ${OrIf} $2 == 0
    ${OrIf} $4 == 0
    ${OrIf} $5 == 0
    ${OrIf} $0 == 0
      Return
    ${EndIf}

    SendMessage $2 0x000C 0 "STR:0% complete - Estimating time left..."
    System::Call "kernel32::GetCurrentProcessId() i.r3"
    ClearErrors
    Exec '"$PLUGINSDIR\ArcRhoInstallerProgress.exe" "$HWNDPARENT" "$0" "$1" "$2" "$4" "$5" "$3"'
    ${If} ${Errors}
      !insertmacro Arcode_PrintInstallDetail "Progress text observer could not be started."
    ${EndIf}
  FunctionEnd

  Function Arcode_InstFiles_CompleteProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1006
    ${If} $0 == 0
    ${OrIf} $1 == 0
      Return
    ${EndIf}
    SendMessage $1 0x000C 0 "STR:[100%] Installation complete."
  FunctionEnd

  !macro customFiles_x64
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_ia32
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_arm64
    !insertmacro Arcode_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro Arcode_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro registerFileAssociations
    !insertmacro Arcode_PrintInstallDetail "[90%] Creating shortcuts and registry entries..."
  !macroend

  !macro customInstall
    Call Arcode_InstFiles_CompleteProgressText
    !insertmacro Arcode_PrintInstallDetail "[100%] Installation complete."
  !macroend
!endif

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Uninstalling Arcode ====="
!macroend
