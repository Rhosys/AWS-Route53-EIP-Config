/* eslint-disable no-console */
// http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-lambda-function-code.html
const { Route53, EC2, ConfigService } = require('aws-sdk');
const configService = new ConfigService();
const route53 = new Route53();

const COMPLIANCE_STATES = {
  COMPLIANT: 'COMPLIANT',
  NON_COMPLIANT: 'NON_COMPLIANT',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
};

// https://docs.aws.amazon.com/lambda/latest/dg/services-config.html
exports.handler = async function(event) {
//   const invokingEvent = JSON.parse(event.invokingEvent);
//   const ruleParameters = JSON.parse(event.ruleParameters);
  let hostedZoneIds;
  try {
    console.log('Looking up hosted zones:');
    hostedZoneIds = (await route53.listHostedZones({ }).promise()).HostedZones.map(hz => hz.Id);
    console.log('   :', hostedZoneIds);
  } catch (error) {
    console.log('  Failed to retrieve hosted zones', error);
    throw error;
  }

  const addresses = [];
  const regions = await new EC2().describeRegions().promise().then(data => data.Regions.map(r => r.RegionName));
  await Promise.all(regions.map(async region => {
    const regionalEc2Client = new EC2({ region });
    addresses.push(...(await regionalEc2Client.describeAddresses().promise()).Addresses.map(a => a.PublicIp));
  }));
  
  const evaluationResults = [];
  await Promise.all(hostedZoneIds.map(async hostedZoneIdParam => {
    const hostedZoneId = hostedZoneIdParam.replace('/hostedzone/', '');
    console.log('Fetching records for zone: ', hostedZoneId);
    const recordAddressMap = {};
    const params = { HostedZoneId: hostedZoneIdParam };
    try {
      do {
        const response = await route53.listResourceRecordSets(params).promise();
        params.StartRecordIdentifier = response.NextRecordIdentifier;
        response.ResourceRecordSets
        .filter(t => !t.AliasTarget && t.Type === 'A')
        .map(r => ({ hostedZoneId, name: r.Name.replace(/[.]$/, ''), type: r.Type, originalRecord: r }))
        .forEach(r => {
          r.originalRecord.ResourceRecords.map(rr => rr.Value).forEach(address => {
            if (!recordAddressMap[address]) {
              recordAddressMap[address] = [];
            }
            recordAddressMap[address].push(r);
          });
        });
      } while (params.StartRecordIdentifier);
    } catch (error) {
      console.error(`Failed to get records for zone: ${hostedZoneId}:`, error);
    }

    const possiblyCompliantRecords = {};
    addresses.forEach(a => {
      Object.values(recordAddressMap).forEach(list => {
        list.forEach(r => {
          possiblyCompliantRecords[r.name] = { name: r.name, type: r.type };
        });
      });
      delete recordAddressMap[a];
    });

    const recordMap = {};
    Object.keys(recordAddressMap).forEach(ipAddress => {
      recordAddressMap[ipAddress].forEach(record => {
        if (!recordMap[record.name]) {
          recordMap[record.name] = { name: record.name, type: record.type, ipAddresses: {} };
        }
        recordMap[record.name].ipAddresses[ipAddress] = true;
      });
    });
    console.log('Records with non-existent Ip Addresses:', Object.keys(recordMap));

    evaluationResults.push(...Object.values(recordMap).map(record => ({
      Annotation: `IPv4: ${Object.keys(record.ipAddresses).join(', ')}`,
      ComplianceResourceType: 'AWS::::Account',
      ComplianceResourceId: `aws:${event.accountId}:hostedzone:${hostedZoneId}:${record.name}:type:${record.type}`,
      ComplianceType: COMPLIANCE_STATES.NON_COMPLIANT,
      OrderingTimestamp: new Date()
    })));

    try {
      const existingCompliance = await configService.getComplianceDetailsByConfigRule({ ConfigRuleName: event.configRuleName, ComplianceTypes: ['NON_COMPLIANT'] }).promise();
      evaluationResults.push(...existingCompliance.EvaluationResults.map(result => {
        const resourceData = result.EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId.split(':');
        const accountId = resourceData[1];
        const rHostedZoneId = resourceData[3];

        if (rHostedZoneId !== hostedZoneId || accountId !== event.accountId) {
          return null;
        }
        
        return {
          ComplianceResourceType: 'AWS::::Account',
          ComplianceResourceId: result.EvaluationResultIdentifier.EvaluationResultQualifier.ResourceId,
          ComplianceType: COMPLIANCE_STATES.COMPLIANT,
          OrderingTimestamp: new Date()
        };
      }));
    } catch (error) {
      console.error('Does not hav access to update existing record resource Compliance status', error);
    }

    await configService.putEvaluations({ Evaluations: evaluationResults.filter(r => r), ResultToken: event.resultToken }).promise();
  }));
};
