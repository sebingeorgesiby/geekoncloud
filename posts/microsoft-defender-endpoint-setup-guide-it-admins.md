---
title: "Microsoft Defender for Endpoint Setup Guide for IT Admins"
date: 2026-04-29
excerpt: "Deploy Microsoft Defender for Endpoint across your org. Step-by-step onboarding, GPO configs, Intune policies, and alert tuning for production environments."
tags: ["microsoft-defender","endpoint-security","intune","windows-security","siem"]
author: GeekOnCloud
draft: false
---

Every enterprise security team eventually faces the same question: how do we get consistent endpoint protection across Windows, macOS, and Linux without deploying three different solutions? Microsoft Defender for Endpoint (MDE) answers that question, but the onboarding process is where most IT admins get stuck. I've deployed MDE across organizations ranging from 500 to 50,000 endpoints, and the difference between a smooth rollout and a support ticket nightmare comes down to preparation and methodology.

This guide covers the actual steps to get MDE running in productionâ€”not the marketing overview, but the commands you'll run and the decisions you'll make.

## Prerequisites and Licensing Reality Check

Before touching any endpoints, verify your licensing. MDE requires one of these:
- Microsoft 365 E5
- Microsoft 365 E5 Security
- Microsoft Defender for Endpoint Plan 1 or Plan 2 (standalone)
- Windows 10/11 Enterprise E5

The Plan 1 vs Plan 2 distinction matters. Plan 1 gives you next-gen protection, attack surface reduction, and device control. Plan 2 adds EDR, automated investigation, threat hunting, and the full threat analytics suite. Most organizations doing serious security work need Plan 2.

Check your current licenses in the Microsoft 365 admin center under **Billing > Licenses**. If you see "Microsoft Defender for Endpoint" or "Microsoft 365 E5 Security," you're covered.

You'll also need:
- Global Administrator or Security Administrator role in Azure AD
- Network connectivity from endpoints to `*.securitycenter.windows.com`, `*.blob.core.windows.net`, and `*.ods.opinsights.azure.com` on port 443
- Windows 10 1709+ or Windows 11, macOS 11+, or a supported Linux distribution (RHEL 7.2+, Ubuntu 16.04+, Debian 9+)

## Configuring the Security Portal

Start in the Microsoft 365 Defender portal at `security.microsoft.com`. Navigate to **Settings > Endpoints > Onboarding** and select your operating system. But before downloading any packages, configure your baseline settings.

Under **Settings > Endpoints > Advanced features**, enable these:
- **Automated Investigation** â€” set to "Full" for Plan 2
- **Live Response** â€” critical for incident response
- **Live Response unsigned script execution** â€” enable only if your IR team needs it
- **Tamper Protection** â€” always enable this
- **Web content filtering** â€” if you're replacing a proxy-based web filter

Device groups matter for RBAC and automated response policies. Create them under **Settings > Endpoints > Device groups** before onboarding. A typical structure:

```
â”œâ”€â”€ Production Servers
â”‚   â”œâ”€â”€ Windows Servers
â”‚   â””â”€â”€ Linux Servers
â”œâ”€â”€ Workstations
â”‚   â”œâ”€â”€ IT Department
â”‚   â”œâ”€â”€ Finance (High Sensitivity)
â”‚   â””â”€â”€ General Users
â””â”€â”€ Test/Dev Machines
```

Use the "Rank" field to control evaluation orderâ€”devices match the first group rule that applies.

## Windows Endpoint Onboarding

For Windows, you have four primary deployment methods: Group Policy, Intune, SCCM/MECM, or local script. In production environments, Intune or SCCM are the only sensible choices.

### Intune Method

Create a device configuration profile:

1. **Devices > Configuration profiles > Create profile**
2. Platform: Windows 10 and later
3. Profile type: Templates > Microsoft Defender for Endpoint (Windows 10 Desktop)

The profile automatically pulls your onboarding blob from the tenant. Deploy to a test group firstâ€”always.

### SCCM/MECM Method

Download the onboarding package from the Defender portal (**Settings > Endpoints > Onboarding > Windows 10/11 > Microsoft Endpoint Configuration Manager**). You'll get a `.zip` containing `WindowsDefenderATPOnboardingScript.cmd` and a config file.

Create a package in SCCM:

```powershell
# Deploy via SCCM task sequence or package
# The script accepts no parameters - it reads the config from the same directory
cmd.exe /c WindowsDefenderATPOnboardingScript.cmd

# Verify onboarding status via registry
$onboardingState = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows Advanced Threat Protection\Status" -Name "OnboardingState"
if ($onboardingState.OnboardingState -eq 1) {
    Write-Output "Device successfully onboarded to MDE"
} else {
    Write-Error "Onboarding failed - state: $($onboardingState.OnboardingState)"
}

# Force a detection test
# Download the test file - this triggers a benign alert
Invoke-WebRequest -Uri "https://aka.ms/ioavtest" -OutFile "$env:TEMP\MDE_test.txt"
```

Onboarded devices appear in the portal within 5-30 minutes. If you're not seeing them, check the `Microsoft-Windows-SENSE/Operational` event log for errors.

## Linux Server Onboarding

Linux onboarding requires more hands-on work. Microsoft provides a Python-based installer and supports apt/yum repositories.

First, add the Microsoft repository:

```bash
#!/bin/bash
# For RHEL/CentOS 7+
sudo yum install -y yum-utils
sudo yum-config-manager --add-repo=https://packages.microsoft.com/config/rhel/7/prod.repo
sudo yum install -y mdatp

# For Ubuntu 20.04+
curl -o microsoft.list https://packages.microsoft.com/config/ubuntu/20.04/prod.list
sudo mv ./microsoft.list /etc/apt/sources.list.d/microsoft-prod.list
sudo apt-get install -y gpg
curl https://packages.microsoft.com/keys/microsoft.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y mdatp

# Onboard using the downloaded JSON config
# Download onboarding package from: Settings > Endpoints > Onboarding > Linux Server
sudo mdatp onboard --onboarding_blob "$(cat MicrosoftDefenderATPOnboardingLinuxServer.json)"

# Verify connectivity and health
mdatp health
mdatp connectivity test

# Expected healthy output includes:
# healthy: true
# org_id: your-tenant-id
# real_time_protection_enabled: true
```

Watch out for kernel compatibility. MDE's real-time protection uses eBPF on newer kernels (5.0+) or a kernel module on older ones. If you're running a custom kernel, verify support with `mdatp health --field kernel_module_status`.

## Attack Surface Reduction and Policy Tuning

Onboarding is only step one. The real protection comes from properly configured Attack Surface Reduction (ASR) rules. These rules block specific behaviors exploited by malwareâ€”like Office applications spawning child processes or scripts obfuscating their execution.

Start in audit mode. Always. Deploy ASR rules in block mode on day one and you'll break legitimate applications faster than you can open support tickets.

Configure via Intune under **Endpoint Security > Attack Surface Reduction > Create Policy**:

```yaml
# Recommended initial ASR configuration - Audit Mode
Block abuse of exploited vulnerable signed drivers: Audit
Block Adobe Reader from creating child processes: Audit
Block all Office applications from creating child processes: Audit
Block credential stealing from Windows LSASS: Block  # This one's safe to block immediately
Block executable content from email client and webmail: Audit
Block execution of potentially obfuscated scripts: Audit
Block JavaScript or VBScript from launching downloaded executable content: Audit
Block Office applications from creating executable content: Audit
Block Office applications from injecting code into other processes: Audit
Block Office communication application from creating child processes: Audit
Block persistence through WMI event subscription: Audit
Block process creations originating from PSExec and WMI commands: Audit
Block untrusted and unsigned processes that run from USB: Block
Block Win32 API calls from Office macros: Audit
Use advanced protection against ransomware: Audit
```

Run audit mode for 2-4 weeks. Review blocked actions in **Reports > Security Report > Attack Surface Reduction Rules**. You'll identify legitimate applications triggering rulesâ€”add exclusions for those specific paths, then switch rules to block mode one at a time.

## Monitoring and Validation

After deployment, verify everything actually works. The Defender portal's **Device Inventory** shows onboarding status and health metrics. Sort by "Onboarding status" to identify stragglers.

Set up email notifications under **Settings > Endpoints > Email notifications** for high-severity alerts. Create separate notification rules for server vs. workstation device groupsâ€”your SOC doesn't need 3 AM pages for a user clicking a phishing link, but a server executing encoded PowerShell commands deserves immediate attention.

Run the EICAR test file to verify detection and alerting pipeline end-to-end. If alerts don't appear within 15 minutes, check network connectivity to Microsoft endpoints and verify the SENSE service is running.

Your next step: deploy to a pilot group of 50-100 machines across different business units, run ASR in audit mode for two weeks, then schedule the production rollout based on what you learn. Don't skip the pilotâ€”the applications that break will always be the ones someone forgot to document.

---

## Tools & Resources

*Tools relevant to this post. Some links are affiliate links — they cost you nothing and help keep geekoncloud.com running.*

- **[Datadog](https://www.datadoghq.com/?utm_source=geekoncloud)** — cloud monitoring and observability platform
- **[Snyk](https://snyk.io/?utm_source=geekoncloud)** — developer-first security and vulnerability scanning
- **[CircleCI](https://circleci.com/?utm_source=geekoncloud)** — fast and reliable CI/CD pipelines
