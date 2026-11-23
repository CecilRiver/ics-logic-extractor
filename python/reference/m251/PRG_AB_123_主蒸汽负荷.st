(* ============================================================
   PLC .123  TM251MESC  主蒸汽 / 负荷控制
   POU: PRG_AB   (MAST 任务下调用)
   来源：现场工程 M251_Comms.project，2026-11-23 烧录版本
   ============================================================ *)

PROGRAM PRG_AB
VAR
    LoadSteam       : FB_CombinedLoadSteamController;
    BoilerMaster    : FB_BoilerMasterController;
    HB_Timer        : TON;
    InitDone        : BOOL := FALSE;
    ResetController : BOOL;

    Ts              : REAL := 0.1;
    SteamSetpoint   : REAL;
    BoilerCmd       : REAL;
    Heartbeat       : INT;

    (* ===== 仿真变量 ===== *)
    SimCnt          : INT;
    SimD            : DINT;
END_VAR

ResetController := NOT InitDone;

LoadSteam(
    Reset               := ResetController,
    Ts                  := Ts,
    ActualLoad          := GVL.HMI_ActualLoad,
    PressureBias        := GVL.HMI_PressureBias,
    UnitPressureSPInput := GVL.HMI_UnitPressureSPInput
);

SteamSetpoint := LoadSteam.UnitPressureSetpoint;

BoilerMaster(
    Reset             := ResetController,
    Ts                := Ts,
    MainSteamPressure := GVL.HMI_MainSteamPressure,
    SteamSetpoint     := SteamSetpoint
);
BoilerCmd := BoilerMaster.BoilerMasterCommand;

HB_Timer(IN := NOT HB_Timer.Q, PT := T#1S);
IF HB_Timer.Q THEN
    Heartbeat := Heartbeat + 1;
    IF Heartbeat >= 32768 THEN
        Heartbeat := 0;
    END_IF;
END_IF;

(* ============================================================
   仿真数据：由 PLC 自己产生（三角波）
   MB_Reg[0] 实际负荷×10   [1] 负荷上限×10  [2] 压力设定×10
   MB_Reg[3] 滑压压力×10   [4] 锅炉指令×10  [5] 心跳
   MB_Reg[6] 水冷壁温度×10
   ============================================================ *)
SimCnt := SimCnt + 1;
IF SimCnt >= 1200 THEN
    SimCnt := 0;
END_IF;

(* 锅炉指令三角波 150.0 ~ 165.0 t/h *)
IF SimCnt < 600 THEN
    GVL.MB_Reg[4] := 1500 + (SimCnt / 4);
ELSE
    GVL.MB_Reg[4] := 1650 - ((SimCnt - 600) / 4);
END_IF;

(* 实际负荷 = 锅炉指令 × 2.21，用 DINT 防溢出 *)
SimD := TO_DINT(GVL.MB_Reg[4]) * 221;
GVL.MB_Reg[0] := DINT_TO_INT(SimD / 100);
GVL.MB_Reg[1] := GVL.MB_Reg[0];

(* 压力设定 23.5 ~ 24.4 MPa *)
GVL.MB_Reg[2] := 235 + (SimCnt / 60);
GVL.MB_Reg[3] := GVL.MB_Reg[2];

(* 水冷壁温度恒定 425.0 ℃ *)
GVL.MB_Reg[6] := 4250;

GVL.MB_Reg[5] := Heartbeat;

NVL_M251_TO_MESE.BoilerMasterCommand := GVL.MB_Reg[4];
NVL_M251_TO_MESE.Heartbeat           := Heartbeat;

InitDone := TRUE;
