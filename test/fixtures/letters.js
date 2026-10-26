'use strict';
// Fictional letters in the layouts used by card brands and labs. Vendor,
// devices, numbers and people are invented ("Northwind Terminals").

const amex = `May 22, 2024

Northwind Terminals Attn: Pat Doe 1 Main Street, Springfield

Approval Number: 42.LABX.NORTHWIND.NX200.20240522-F

RE: Expresspay 4.2 Reader Certification

Product Name: NX200 Firmware Version: 01.00 As Tested in: NX200

Dear Pat,

We are pleased to inform you that American Express has certified the NX200 for Expresspay 4.2 using Firmware Version 01.00. This Expresspay 4.2 certification is valid for three years from the date of issuance.

Sincerely,

Network and Acquirer Solutions American Express`;

const discover = `Pat Doe Northwind Terminals 1 Main Street

January 5, 2026

Re: Discover D-PAS – Type Approval Letter

Vendor: Northwind Terminals Vendor Reference Number: R_0001 D-PAS Specification Version: D-PAS Contactless v2.0 Product: Flex/3XXX CL1 Product Reference Number: NW_FLEX3XXX_CTL_2021 Hardware Version: HW1 Firmware Version: SW 1.0 Kernel Version: 123 v0406 Approval Expiration Date: January 5, 2029

Dear Pat:

Discover hereby confirms its type approval of the Product.

Please note that this approval will expire on January 5, 2029 ("Expiration Date").

Sincerely,

Discover Network`;

const emvco = `January 10, 2024

Re: EMVCo Letter of Approval - Contact Terminal Level 1

Approval Number(s): 12345 0124 430 43a 43a LABX

Terminal: NX100 PinPad: none

As tested in: NX100 Version 1.0

Renewal Date: June 30, 2028

Dear Pat,

EMVCo has reviewed the test results.

Sincerely, EMVCo`;

const mastercard = `Mastercard 2000 Purchase Street

Northwind Terminals 1 Main Street

April 15, 2025 Mastercard Contactless Reader Vendor Product – Letter of Approval

LoA Identifier: TLOA-NW250415(a) Product Vendor: Northwind Terminals LoA Expiration Date: September 5, 2028

Product Identification Fully Integrated Terminal Product Commercial Name NX200 & NX300 Product Technical Name NX200 & NX300 version MCL4.0

Sincerely, Mastercard`;

const pci = `PCI Security Standards Council Letter of Approval

PTS Approval Number: 4-12345

Approval Date: Effective Date: June 21, 2024 Expiry Date: April 30, 2031

Device Name & Model Number: NX100 Hardware #: HW1

Approved under PCI PTS POI Modular Security Requirements v6.1

Sincerely, PCI Security Standards Council`;

const bulletin = `EMV Level 1 Contact - Product Configuration Bulletin

NX100

Date: 03 Jan 2025

This bulletin describes the configuration of the approved interface.`;

module.exports = { amex, discover, emvco, mastercard, pci, bulletin };
