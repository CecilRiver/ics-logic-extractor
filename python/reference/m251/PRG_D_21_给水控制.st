(* ============================================================
   PLC .21  TM251MESE  给水控制
   POU: PRG_D   (MAST 任务下调用)
   来源：现场工程 MESE_Comms.project，2026-11-23 烧录版本
   ============================================================ *)

PROGRAM PRG_D
VAR
    Feedwater       : FB_FeedwaterSystem;
    HB_Timer        : TON;
    CommTimer       : TON;
    InitDone        : BOOL := FALSE;
    ResetController : BOOL;
    Ts              : REAL := 0.1;
    LastUpHB        : INT := -1;
    BoilerSetpoint  : REAL := 157.6;
    BspLast         : REAL := 157.6;
    Heartbeat       : INT;
    CommLost        : BOOL;
END_VAR

(* ---- 与 .123 的心跳监视：5 秒收不到就认为通信中断 ---- *)
IF NVL_M251_TO_MESE.Heartbeat <> LastUpHB THEN
    LastUpHB := NVL_M251_TO_MESE.Heartbeat;
    CommTimer(IN := FALSE);
ELSE
    CommTimer(IN := TRUE, PT := T#5S);
END_IF;
CommLost := CommTimer.Q;

(* ---- 从 .123 取锅炉指令，通信中断则保持上次值 ---- *)
IF CommLost THEN
    BoilerSetpoint := BspLast;
ELSE
    BoilerSetpoint := INT_TO_REAL(NVL_M251_TO_MESE.BoilerMasterCommand) / 10.0;
    BspLast := BoilerSetpoint;
END_IF;

ResetController := NOT InitDone;

(* ===== 仿真：给水流量与主汽流量跟随设定值 ===== *)
GVL.HMI_FeedwaterFlow := Feedwater.WaterSetpoint;
GVL.HMI_MainSteamFlow := Feedwater.WaterSetpoint * 0.999;

Feedwater(
    Reset          := ResetController,
    Ts             := Ts,
    BoilerSetpoint := BoilerSetpoint,
    PressureBias   := GVL.HMI_PressureBias,
    MainSteamFlow  := GVL.HMI_MainSteamFlow,
    FeedwaterFlow  := GVL.HMI_FeedwaterFlow
);

HB_Timer(IN := NOT HB_Timer.Q, PT := T#1S);
IF HB_Timer.Q THEN
    Heartbeat := Heartbeat + 1;
    IF Heartbeat >= 32768 THEN
        Heartbeat := 0;
    END_IF;
END_IF;

(* ===== 输出到 Modbus 寄存器（组态王读取）===== *)
GVL.MB_Reg[0] := REAL_TO_INT(GVL.HMI_FeedwaterFlow * 10.0);      (* 给水流量 ×10 *)
GVL.MB_Reg[1] := REAL_TO_INT(Feedwater.WaterSetpoint * 10.0);    (* 给水设定 ×10 *)
GVL.MB_Reg[2] := 20;                                             (* 泵运行台数 2.0 *)
GVL.MB_Reg[3] := BOOL_TO_INT(Feedwater.AlarmWaterDeviation);     (* 报警字 *)
GVL.MB_Reg[4] := Heartbeat;                                      (* 心跳 *)

InitDone := TRUE;
