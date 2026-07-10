; Custom NSIS script for richer installation detail output and progress text.

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var ArcRhoInstallProgressLastText
  Var ArcRhoInstallExcelAddIn
  Var ArcRhoInstallExcelAddInCheckbox
  Var ArcRhoServerRoot
  Var ArcRhoServerRootDetected
  Var ArcRhoServerDriveDropList
  Var ArcRhoExcelAddInPath

  !macro ArcRho_PrintInstallDetail MSG
    SetDetailsPrint both
    SetDetailsView show
    DetailPrint "${MSG}"
  !macroend
!endif

; Keep details visible by default so users can inspect installer actions.
ShowInstDetails show
ShowUninstDetails show

!macro preInit
  SetDetailsPrint both
!macroend

!macro customInit
  SetDetailsPrint both
  SetDetailsView show
  StrCpy $ArcRhoInstallExcelAddIn "1"
  Call ArcRho_DetectServerRoot
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
    StrCpy $ArcRhoInstallProgressLastText ""
    !insertmacro ArcRho_PrintInstallDetail "Installer progress monitoring started."
    !insertmacro ArcRho_PrintInstallDetail "Preparing destination and installing ArcRho files..."
    Call ArcRho_InstFiles_UpdateProgressText
    nsDialogs::CreateTimer ArcRho_InstFiles_UpdateProgressText 500
  FunctionEnd

  Function ArcRho_InstFiles_UpdateProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1004
    GetDlgItem $2 $0 1006
    ${If} $1 == 0
    ${OrIf} $2 == 0
    ${OrIf} $0 == 0
      Return
    ${EndIf}

    SendMessage $1 0x0408 0 0 $3
    SendMessage $1 0x0407 0 0 $4
    SendMessage $1 0x0407 1 0 $5
    IntOp $8 $4 - $5
    ${If} $8 <= 0
      Return
    ${EndIf}

    IntOp $6 $3 - $5
    IntOp $6 $6 * 100
    IntOp $6 $6 / $8
    ${If} $6 < 10
      StrCpy $6 10
    ${ElseIf} $6 > 99
      StrCpy $6 99
    ${EndIf}

    StrCpy $7 "[$6%] Installing ArcRho files..."
    ${If} $7 != $ArcRhoInstallProgressLastText
      StrCpy $ArcRhoInstallProgressLastText $7
      SendMessage $2 0x000C 0 "STR:$7"
    ${EndIf}
  FunctionEnd

  Function ArcRho_InstFiles_CompleteProgressText
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $1 $0 1006
    ${If} $0 == 0
    ${OrIf} $1 == 0
      Return
    ${EndIf}
    SendMessage $1 0x000C 0 "STR:[100%] Installation complete."
  FunctionEnd

  ; electron-builder runs this after the embedded package is extracted.
  !macro customFiles_x64
    !insertmacro ArcRho_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro ArcRho_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_ia32
    !insertmacro ArcRho_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro ArcRho_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  !macro customFiles_arm64
    !insertmacro ArcRho_PrintInstallDetail "[65%] Core application files extracted."
    !insertmacro ArcRho_PrintInstallDetail "[75%] Writing installer metadata..."
  !macroend

  ; Optional no-op hook used only to surface a progress line between file extraction and final completion.
  !macro registerFileAssociations
    !insertmacro ArcRho_PrintInstallDetail "[90%] Creating shortcuts and registry entries..."
  !macroend

  Function ArcRho_InstallExcelAddIn
    InitPluginsDir
    File /oname=$PLUGINSDIR\install_arcrho_excel_addin.ps1 "${PROJECT_DIR}\build\install_arcrho_excel_addin.ps1"
    Call ArcRho_SetExcelAddInPath

    ${If} $ArcRhoExcelAddInPath == ""
      !insertmacro ArcRho_PrintInstallDetail "[95%] ArcRho Excel add-in installation skipped because no ArcRho Server root was selected or detected."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically because no ArcRho Server root was selected or detected."
      ${EndIf}
      Return
    ${EndIf}

    !insertmacro ArcRho_PrintInstallDetail "[95%] Installing ArcRho Excel add-in..."
    !insertmacro ArcRho_PrintInstallDetail "[95%] Excel add-in path: $ArcRhoExcelAddInPath"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -STA -File "$PLUGINSDIR\install_arcrho_excel_addin.ps1" -AddInPath "$ArcRhoExcelAddInPath"'
    Pop $0
    Pop $1

    ${If} $1 != ""
      !insertmacro ArcRho_PrintInstallDetail "$1"
    ${EndIf}

    ${If} $0 == 0
      !insertmacro ArcRho_PrintInstallDetail "[95%] ArcRho Excel add-in installed."
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "[95%] ArcRho Excel add-in installation failed with exit code $0."
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "ArcRho was installed, but the Excel add-in could not be installed automatically. You can install it manually from $ArcRhoExcelAddInPath.$\r$\n$\r$\n$1"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  !macro customInstall
    nsDialogs::KillTimer ArcRho_InstFiles_UpdateProgressText
    ${If} $ArcRhoInstallExcelAddIn == "1"
      Call ArcRho_InstallExcelAddIn
    ${Else}
      !insertmacro ArcRho_PrintInstallDetail "[95%] ArcRho Excel add-in installation skipped."
    ${EndIf}
    Call ArcRho_InstFiles_CompleteProgressText
    !insertmacro ArcRho_PrintInstallDetail "[100%] Installation complete."
  !macroend
!endif

!macro customUnInstall
  SetDetailsPrint both
  SetDetailsView show
  DetailPrint "===== Uninstalling ArcRho ====="
!macroend
