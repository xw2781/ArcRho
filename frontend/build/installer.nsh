; Custom NSIS script for richer installation detail output and progress text.

; electron-builder prepends this custom include before its own MUI2 include.
; Load MUI2 here so MUI_HEADER_TEXT is defined when the functions below are parsed.
!ifndef MUI_INCLUDED
  !include "MUI2.nsh"
!endif

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  ; electron-builder expands this hook after common.nsh, whose default is
  ; "nevershow". Keep the log collapsed while exposing the native Show details
  ; control on the assisted installer page.
  !macro customHeader
    ShowInstDetails hide
  !macroend

  Var ArcRhoInstallExcelAddIn
  Var ArcRhoInstallExcelAddInCheckbox
  Var ArcRhoServerRoot
  Var ArcRhoServerRootDetected
  Var ArcRhoServerDriveDropList
  Var ArcRhoExcelAddInPath

  !macro ArcRho_PrintInstallDetail MSG
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
  StrCpy $ArcRhoInstallExcelAddIn "1"
  Call ArcRho_DetectServerRoot
  ${IfNot} ${Silent}
    ; Extract the observer before the InstFiles worker starts. It only reads
    ; the native bar and never executes installer script on the UI thread.
    InitPluginsDir
    File /oname=$PLUGINSDIR\ArcRhoInstallerProgress.exe "${PROJECT_DIR}\build\generated\ArcRhoInstallerProgress.exe"
  ${EndIf}
  DetailPrint "===== Installing ArcRho ====="
  DetailPrint "Preparing installation..."
!macroend

; This hook is inserted immediately before MUI_PAGE_INSTFILES.
!ifndef BUILD_UNINSTALLER
  !macro ArcRho_CheckServerRoot DRIVE
    ${If} $ArcRhoServerRoot == ""
    ${AndIf} ${FileExists} "${DRIVE}\ArcRho Server\*.*"
      StrCpy $ArcRhoServerRoot "${DRIVE}\ArcRho Server"
      StrCpy $ArcRhoServerRootDetected "1"
    ${EndIf}
  !macroend

  !macro ArcRho_AddDriveOption DRIVE
    ${If} ${FileExists} "${DRIVE}\*.*"
      ${NSD_CB_AddString} $ArcRhoServerDriveDropList "${DRIVE}"
      ${If} $ArcRhoServerRoot == ""
        StrCpy $ArcRhoServerRoot "${DRIVE}\ArcRho Server"
        ${NSD_CB_SelectString} $ArcRhoServerDriveDropList "${DRIVE}"
      ${EndIf}
    ${EndIf}
  !macroend

  !macro customWelcomePage
    Page custom ArcRho_ExcelAddInOptions_Show ArcRho_ExcelAddInOptions_Leave
  !macroend

  Function ArcRho_DetectServerRoot
    StrCpy $ArcRhoServerRoot ""
    StrCpy $ArcRhoServerRootDetected "0"
    !insertmacro ArcRho_CheckServerRoot "C:"
    !insertmacro ArcRho_CheckServerRoot "D:"
    !insertmacro ArcRho_CheckServerRoot "E:"
    !insertmacro ArcRho_CheckServerRoot "F:"
    !insertmacro ArcRho_CheckServerRoot "G:"
    !insertmacro ArcRho_CheckServerRoot "H:"
    !insertmacro ArcRho_CheckServerRoot "I:"
    !insertmacro ArcRho_CheckServerRoot "J:"
    !insertmacro ArcRho_CheckServerRoot "K:"
    !insertmacro ArcRho_CheckServerRoot "L:"
    !insertmacro ArcRho_CheckServerRoot "M:"
    !insertmacro ArcRho_CheckServerRoot "N:"
    !insertmacro ArcRho_CheckServerRoot "O:"
    !insertmacro ArcRho_CheckServerRoot "P:"
    !insertmacro ArcRho_CheckServerRoot "Q:"
    !insertmacro ArcRho_CheckServerRoot "R:"
    !insertmacro ArcRho_CheckServerRoot "S:"
    !insertmacro ArcRho_CheckServerRoot "T:"
    !insertmacro ArcRho_CheckServerRoot "U:"
    !insertmacro ArcRho_CheckServerRoot "V:"
    !insertmacro ArcRho_CheckServerRoot "W:"
    !insertmacro ArcRho_CheckServerRoot "X:"
    !insertmacro ArcRho_CheckServerRoot "Y:"
    !insertmacro ArcRho_CheckServerRoot "Z:"
  FunctionEnd

  Function ArcRho_SetExcelAddInPath
    ${If} $ArcRhoServerRoot != ""
      StrCpy $ArcRhoExcelAddInPath "$ArcRhoServerRoot\Excel Add-ins\ArcRho.xlam"
    ${Else}
      StrCpy $ArcRhoExcelAddInPath ""
    ${EndIf}
  FunctionEnd

  Function ArcRho_ExcelAddInOptions_Show
    !insertmacro MUI_HEADER_TEXT "Excel Add-in" "Choose whether to install the ArcRho Excel add-in."

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 22u "ArcRho can register the Excel add-in during setup."
    Pop $1

    ${If} $ArcRhoServerRootDetected == "1"
      ${NSD_CreateLabel} 0 30u 100% 22u "Detected ArcRho Server folder: $ArcRhoServerRoot"
      Pop $1
    ${Else}
      ${NSD_CreateLabel} 0 30u 100% 22u "Select the drive where ArcRho Server should be located:"
      Pop $1
      ${NSD_CreateDropList} 0 54u 80u 80u ""
      Pop $ArcRhoServerDriveDropList
      StrCpy $ArcRhoServerRoot ""
      !insertmacro ArcRho_AddDriveOption "C:"
      !insertmacro ArcRho_AddDriveOption "D:"
      !insertmacro ArcRho_AddDriveOption "E:"
      !insertmacro ArcRho_AddDriveOption "F:"
      !insertmacro ArcRho_AddDriveOption "G:"
      !insertmacro ArcRho_AddDriveOption "H:"
      !insertmacro ArcRho_AddDriveOption "I:"
      !insertmacro ArcRho_AddDriveOption "J:"
      !insertmacro ArcRho_AddDriveOption "K:"
      !insertmacro ArcRho_AddDriveOption "L:"
      !insertmacro ArcRho_AddDriveOption "M:"
      !insertmacro ArcRho_AddDriveOption "N:"
      !insertmacro ArcRho_AddDriveOption "O:"
      !insertmacro ArcRho_AddDriveOption "P:"
      !insertmacro ArcRho_AddDriveOption "Q:"
      !insertmacro ArcRho_AddDriveOption "R:"
      !insertmacro ArcRho_AddDriveOption "S:"
      !insertmacro ArcRho_AddDriveOption "T:"
      !insertmacro ArcRho_AddDriveOption "U:"
      !insertmacro ArcRho_AddDriveOption "V:"
      !insertmacro ArcRho_AddDriveOption "W:"
      !insertmacro ArcRho_AddDriveOption "X:"
      !insertmacro ArcRho_AddDriveOption "Y:"
      !insertmacro ArcRho_AddDriveOption "Z:"
      ${NSD_CreateLabel} 0 80u 100% 22u "Excel add-in path will use <drive>\ArcRho Server\Excel Add-ins\ArcRho.xlam."
      Pop $1
    ${EndIf}

    ${NSD_CreateCheckbox} 0 112u 100% 26u "Install ArcRho Excel add-in"
    Pop $ArcRhoInstallExcelAddInCheckbox
    ${If} $ArcRhoInstallExcelAddIn == "1"
      ${NSD_Check} $ArcRhoInstallExcelAddInCheckbox
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function ArcRho_ExcelAddInOptions_Leave
    ${NSD_GetState} $ArcRhoInstallExcelAddInCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $ArcRhoInstallExcelAddIn "1"
    ${Else}
      StrCpy $ArcRhoInstallExcelAddIn "0"
    ${EndIf}

    ${If} $ArcRhoServerRootDetected != "1"
      ${NSD_GetText} $ArcRhoServerDriveDropList $0
      ${If} $0 != ""
        StrCpy $ArcRhoServerRoot "$0\ArcRho Server"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW ArcRho_InstFiles_Show
  !macroend

  Function ArcRho_InstFiles_Show
    !insertmacro MUI_HEADER_TEXT "" "$(MUI_TEXT_INSTALLING_SUBTITLE)"
    !insertmacro ArcRho_PrintInstallDetail "Installer progress monitoring started."
    !insertmacro ArcRho_PrintInstallDetail "Preparing destination and installing ArcRho files..."
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    GetDlgItem $2 $0 1006
    ; Standard NSIS InstFiles control IDs: details list and Show details button.
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
      !insertmacro ArcRho_PrintInstallDetail "Progress text observer could not be started."
    ${EndIf}
  FunctionEnd

  Function ArcRho_InstFiles_CompleteProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1006
    ${If} $0 == 0
    ${OrIf} $1 == 0
      Return
    ${EndIf}
    SendMessage $1 0x000C 0 "STR:100% complete - Installation complete."
  FunctionEnd

  !macro ArcRho_PrintCoreFileDetails
    !insertmacro ArcRho_PrintInstallDetail "Core application files extracted."
    !insertmacro ArcRho_PrintInstallDetail "Writing installer metadata..."
  !macroend

  ; electron-builder runs the matching hook after the embedded package is extracted.
  !macro customFiles_x64
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  !macro customFiles_ia32
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  !macro customFiles_arm64
    !insertmacro ArcRho_PrintCoreFileDetails
  !macroend

  ; Optional no-op hook used only to surface an action detail before final completion.
  !macro registerFileAssociations
    !insertmacro ArcRho_PrintInstallDetail "Creating shortcuts and registry entries..."
  !macroend

  Function ArcRho_InstallExcelAddIn
    InitPluginsDir
    File /oname=$PLUGINSDIR\install_arcrho_excel_addin.ps1 "${PROJECT_DIR}\build\install_arcrho_excel_addin.ps1"
    Call ArcRho_SetExcelAddInPath

    ${If} $ArcRhoExcelAddInPath == ""
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation skipped because no ArcRho Server root was selected or detected."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically because no ArcRho Server root was selected or detected."
      ${EndIf}
      Return
    ${EndIf}

    !insertmacro ArcRho_PrintInstallDetail "Installing ArcRho Excel add-in..."
    !insertmacro ArcRho_PrintInstallDetail "Excel add-in path: $ArcRhoExcelAddInPath"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -STA -File "$PLUGINSDIR\install_arcrho_excel_addin.ps1" -AddInPath "$ArcRhoExcelAddInPath"'
    Pop $0
    Pop $1

    ${If} $1 != ""
      !insertmacro ArcRho_PrintInstallDetail "$1"
    ${EndIf}

    ${If} $0 == 0
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installed."
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation failed with exit code $0."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically. You can install it manually from $ArcRhoExcelAddInPath.$\r$\n$\r$\n$1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !macro customInstall
    ${If} $ArcRhoInstallExcelAddIn == "1"
      Call ArcRho_InstallExcelAddIn
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "ArcRho Excel add-in installation skipped."
    ${EndIf}
    Call ArcRho_InstFiles_CompleteProgressText
    !insertmacro ArcRho_PrintInstallDetail "Installation complete."
  !macroend
!endif

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Uninstalling ArcRho ====="
!macroend
