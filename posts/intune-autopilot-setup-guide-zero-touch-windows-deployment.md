---
title: "Intune AutoPilot Setup Guide: Zero-Touch Windows Deployment"
date: 2026-04-29
excerpt: "Deploy Windows devices at scale with Intune AutoPilot. From hardware hash collection to dynamic groups and ESP configs. Complete walkthrough."
tags: ["intune","autopilot","windows-deployment","endpoint-management","microsoft-365"]
author: GeekOnCloud
draft: false
---

Picture this: you've just received 200 laptops for your new hires, and your IT team is staring at the prospect of manually configuring each one. That's roughly 2-3 hours per device â€” about 500 hours of repetitive work. Or you could have those laptops shipped directly to employees, who unbox them, sign in, and get a fully configured corporate device in under 30 minutes. That's the promise of Windows Autopilot, and I'm going to show you exactly how to set it up from scratch.

## Understanding What Autopilot Actually Does

Autopilot isn't magic â€” it's a cloud-based device provisioning service that pre-configures Windows devices before users even touch them. When a device boots for the first time, it phones home to Microsoft, checks if it's registered in your Autopilot service, and if so, downloads your configuration profile.

The flow works like this: Hardware vendor â†’ Microsoft Autopilot service â†’ Azure AD join â†’ Intune enrollment â†’ Configuration profiles applied â†’ Apps installed â†’ User gets a ready-to-work device.

You need three things to make this work:
1. **Azure AD Premium P1** (at minimum) or Microsoft 365 Business Premium/E3/E5
2. **Microsoft Intune licenses** for every device
3. **Device hardware hashes** registered in Autopilot

Most organizations already have these through their Microsoft 365 subscriptions without realizing it. Check your licenses in the Microsoft 365 admin center before proceeding.

## Registering Your First Device

Every Autopilot device needs its hardware hash registered with Microsoft. For existing devices, run this PowerShell script on the target machine:

```powershell
# Install the script from PowerShell Gallery
Install-Script -Name Get-WindowsAutopilotInfo -Force

# Export the hardware hash to CSV
Get-WindowsAutopilotInfo -OutputFile C:\Temp\AutopilotHWID.csv

# Or directly upload to Intune (requires Graph permissions)
Get-WindowsAutopilotInfo -Online -GroupTag "Engineering" -AssignedUser "jsmith@company.com"
```

The `-GroupTag` parameter is crucial â€” it lets you categorize devices for different deployment profiles. I typically use tags like `Engineering`, `Sales`, `Executive`, and `Kiosk`.

For new device purchases, work with your hardware vendor (Dell, HP, Lenovo all support this) to have them register hardware hashes at the point of sale. Here's how you'd request it from Dell:

```
Dell Order Portal â†’ Deploy â†’ Windows Autopilot
Tenant Domain: company.onmicrosoft.com
Group Tag: NewHire-2024
```

The vendor uploads hashes directly to your tenant â€” no manual work required. This is the "zero-touch" deployment everyone talks about.

## Creating Your Deployment Profile

Navigate to **Microsoft Intune admin center** â†’ **Devices** â†’ **Windows** â†’ **Windows enrollment** â†’ **Deployment Profiles**.

Here's where most people mess up: they create one generic profile and wonder why it doesn't fit all scenarios. Create specific profiles for specific use cases.

**Standard User Profile Settings:**
- Deployment mode: **User-Driven** (users authenticate during OOBE)
- Join to Azure AD as: **Azure AD joined** (not hybrid unless you have specific legacy requirements)
- Microsoft Software License Terms: **Hide**
- Privacy settings: **Hide**
- Hide change account options: **Yes**
- User account type: **Standard** (never give users local admin by default)
- Allow pre-provisioned deployment: **Yes** (enables white-glove if needed)
- Language/Region: **Operating system default**

**Kiosk/Shared Device Profile Settings:**
- Deployment mode: **Self-Deploying** (no user authentication needed)
- Apply device name template: **KIOSK-%SERIAL%**
- User account type: **Standard**

Assign profiles to Azure AD dynamic device groups based on the GroupTag:

```kusto
# Dynamic membership rule for Engineering devices
(device.devicePhysicalIds -any (_ -contains "[OrderID]:Engineering"))
```

## Building the Configuration Stack

A naked Windows install isn't useful. You need to layer configuration profiles and apps on top. Here's my recommended deployment order using Intune's Enrollment Status Page (ESP):

**Phase 1: Security Baseline (Blocking)**
- BitLocker encryption
- Windows Hello for Business
- Defender for Endpoint onboarding

**Phase 2: Core Configuration (Blocking)**
- Wi-Fi profiles
- VPN configuration
- Certificates for authentication

**Phase 3: Applications (Blocking)**
- Company Portal app
- Microsoft 365 Apps
- Core line-of-business apps

**Phase 4: Additional Apps (Non-blocking)**
- Optional software
- User-requested applications

Create a PowerShell script deployment for items Intune can't natively configure:

```powershell
# Deploy as a Win32 app with Intune
# Filename: Configure-CompanyBaseline.ps1

# Set power plan to High Performance for laptops
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c

# Configure NTP server to internal source
w32tm /config /manualpeerlist:"ntp.company.internal" /syncfromflags:manual /reliable:yes /update
Restart-Service w32time

# Remove bloatware silently
$bloatware = @(
    "Microsoft.BingNews"
    "Microsoft.GetHelp"
    "Microsoft.Getstarted"
    "Microsoft.MicrosoftSolitaireCollection"
    "Microsoft.WindowsFeedbackHub"
    "Microsoft.Xbox*"
)

foreach ($app in $bloatware) {
    Get-AppxPackage -Name $app -AllUsers | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue
    Get-AppxProvisionedPackage -Online | Where-Object DisplayName -like $app | Remove-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue
}

# Set registry keys for corporate compliance
$regPath = "HKLM:\SOFTWARE\Company\Compliance"
if (!(Test-Path $regPath)) { New-Item -Path $regPath -Force }
Set-ItemProperty -Path $regPath -Name "AutopilotProvisioned" -Value (Get-Date -Format "yyyy-MM-dd") -Type String
Set-ItemProperty -Path $regPath -Name "BaselineVersion" -Value "2.1" -Type String

exit 0
```

Package this as a Win32 app (use the Microsoft Win32 Content Prep Tool) and set it as required during ESP.

## Advanced: Pre-Provisioning for White-Glove Deployment

For scenarios where you want IT to partially provision devices before shipping to users, enable pre-provisioning (formerly called white-glove).

The IT technician:
1. Boots the new device
2. Hits **Windows key** five times at the OOBE screen
3. Selects **Windows Autopilot provisioning**
4. Scans a barcode or selects the profile
5. Device downloads configs, joins Azure AD, installs device-targeted apps
6. Technician reseals the device

When the user receives it, they sign in and only user-targeted policies and apps are applied â€” reducing their wait from 45 minutes to under 10.

Enable this in your deployment profile: **Allow pre-provisioned deployment: Yes**

## Monitoring and Troubleshooting

Your devices will fail. Accept this reality and build monitoring into your process.

Check deployment status in Intune: **Devices** â†’ **Monitor** â†’ **Autopilot deployments**

Common failure codes:
- **0x800705B4**: Timeout waiting for app installation. Increase ESP timeout or mark non-critical apps as non-blocking.
- **0x80180014**: Device not registered. Hardware hash wasn't uploaded or sync hasn't completed (wait 15 minutes and retry).
- **0x801c0003**: User not licensed. Assign Intune license to the user before they attempt enrollment.

For deep troubleshooting, collect logs from the device:

```powershell
# Run from elevated PowerShell on the failing device
mdmdiagnosticstool.exe -area Autopilot -cab C:\Temp\AutopilotDiag.cab
```

Extract the cab file and examine `microsoft-windows-devicemanagement-enterprise-diagnostics-provider-admin.evtx` for the actual failure reason.

## Your Next Step

Don't try to boil the ocean. Start with five test devices â€” register their hardware hashes, create a single deployment profile with basic settings, and run through the entire flow manually. Time it. Note what breaks. Iterate.

Once you've successfully provisioned those five devices end-to-end without intervention, work with your hardware vendor to register the next batch of purchased devices automatically. Scale from there.

The goal isn't perfection on day one â€” it's eliminating one manual touchpoint at a time until your IT team stops touching devices entirely.