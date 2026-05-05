import { exec } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * System monitor for Windows environments to track processes and resources.
 */
export class SystemMonitor {
  fallbackProcessList(filter, error) {
    const memory = process.memoryUsage();
    return {
      processes: [
        {
          name: "OmniClaw server",
          pid: String(process.pid),
          sessionName: "node",
          sessionNum: "-",
          memory: `${Math.round(memory.rss / 1024 / 1024)} MB`,
        },
      ],
      count: 1,
      filter,
      status: "degraded",
      error: error.message,
    };
  }

  async listProcesses(filter = "") {
    try {
      // Windows command to list processes
      const cmd = filter 
        ? `tasklist /FI "IMAGENAME eq ${filter}*" /FO CSV /NH` 
        : "tasklist /NH /FO CSV";
      
      const { stdout } = await execAsync(cmd);
      
      if (!stdout || stdout.includes("No tasks are running")) {
        return {
          processes: [],
          count: 0,
          filter
        };
      }

      const lines = stdout.trim().split("\n");
      const processes = lines.map(line => {
        const parts = line.split('","').map(p => p.trim().replace(/^"|"$/g, ''));
        return {
          name: parts[0],
          pid: parts[1],
          sessionName: parts[2],
          sessionNum: parts[3],
          memory: parts[4]
        };
      });

      return {
        processes: processes.slice(0, 50), // Limit to 50 for clarity
        count: processes.length,
        filter
      };
    } catch (error) {
      return this.fallbackProcessList(filter, error);
    }
  }

  async getSystemSummary() {
    try {
      const { stdout: osInfo } = await execAsync("systeminfo | findstr /B /C:\"OS Name\" /C:\"OS Version\" /C:\"Total Physical Memory\"");
      return {
        summary: osInfo.trim(),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        summary: [
          `OS Name: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
          `CPU Cores: ${os.cpus().length}`,
          `Total Physical Memory: ${Math.round(os.totalmem() / 1024 / 1024)} MB`,
          `Free Physical Memory: ${Math.round(os.freemem() / 1024 / 1024)} MB`,
        ].join("\n"),
        timestamp: new Date().toISOString(),
        status: "degraded",
        error: error.message,
      };
    }
  }

  async getComputerStatus() {
    const memory = {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      usedBytes: os.totalmem() - os.freemem(),
      totalGb: Number((os.totalmem() / 1024 / 1024 / 1024).toFixed(2)),
      freeGb: Number((os.freemem() / 1024 / 1024 / 1024).toFixed(2)),
      usedGb: Number(((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(2)),
    };
    let disks = [];
    let diskStatus = "ok";
    try {
      const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress\"";
      const { stdout } = await execAsync(command, { timeout: 10000, maxBuffer: 1024 * 1024 });
      const parsed = JSON.parse(stdout.trim() || "[]");
      disks = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((disk) => {
        const size = Number(disk.Size || 0);
        const free = Number(disk.FreeSpace || 0);
        return {
          drive: disk.DeviceID,
          totalGb: Number((size / 1024 / 1024 / 1024).toFixed(2)),
          freeGb: Number((free / 1024 / 1024 / 1024).toFixed(2)),
          usedGb: Number(((size - free) / 1024 / 1024 / 1024).toFixed(2)),
          freePercent: size ? Number(((free / size) * 100).toFixed(1)) : 0,
        };
      });
    } catch (error) {
      diskStatus = "degraded";
      disks = [{
        drive: "unknown",
        error: error.message,
      }];
    }

    return {
      status: "ok",
      platform: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
      cpuCores: os.cpus().length,
      memory,
      disks,
      diskStatus,
      timestamp: new Date().toISOString(),
    };
  }
}
