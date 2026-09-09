// Name lexicon for person extraction: common Hispanic given names and surnames (accent-folded), plus
// capitalized words that never belong to a personal name. A candidate phrase is a person when it is
// lexically name-like or when the surrounding text says so (age, title, alias, verb); Title-Case headline
// fragments ("Car Bomb", "Naval Academy") fail both tests.

const GIVEN = `jose juan luis carlos miguel jesus francisco antonio alejandro manuel pedro jorge ricardo roberto fernando eduardo javier rafael daniel david mario
sergio alberto arturo ramon raul ruben hector gerardo gustavo guillermo enrique ernesto oscar omar ivan adrian angel andres cesar cristian christian diego edgar efrain
emilio felipe gabriel gilberto gonzalo humberto ignacio isidro ismael joaquin joel jonathan julio leonardo lorenzo marco marcos martin mauricio nemesio nicolas octavio
ovidio pablo ramiro rigoberto rodolfo rodrigo rogelio salvador samuel santiago saul tomas victor vicente abel abraham adan agustin alfonso alfredo alonso amado armando
arnoldo aurelio benjamin bernardo blas cipriano claudio dario domingo edmundo eleazar elias eliseo erick erik esteban eugenio ezequiel fabian fausto federico fidel gaspar
genaro german heriberto hilario horacio hugo isaac israel jaime jeronimo josue lazaro leobardo leopoldo lucas marcelino marcelo mateo maximino moises nestor noe norberto
osvaldo pascual patricio reynaldo rosendo sabino silvestre teodoro ulises uriel valentin archivaldo ana maria guadalupe rosa carmen patricia alejandra adriana claudia
brenda veronica gabriela laura leticia lorena lucia luz margarita marisol martha monica norma olga paola raquel rocio sandra silvia sofia susana teresa yolanda alma
angelica araceli beatriz blanca cecilia dolores elena elizabeth elsa erika esperanza estela fabiola fernanda gloria graciela irma isabel juana julia karla karina liliana
lourdes magdalena marcela mariana maribel mayra miriam nancy natalia ofelia perla pilar rebeca sara socorro valeria ximena`;

const SURNAMES = `garcia hernandez martinez lopez gonzalez perez rodriguez sanchez ramirez cruz flores gomez morales vazquez vasquez reyes jimenez torres diaz gutierrez ruiz mendoza
aguilar ortiz moreno castillo romero alvarez mendez chavez rivera juarez ramos dominguez herrera medina castro vargas guzman velazquez velasquez munoz rojas contreras salazar
luna ortega guerrero cortes estrada soto alvarado delgado rios pena cervantes nunez silva ibarra marquez campos cabrera cardenas fuentes leon lara navarro ochoa padilla ayala
pacheco avila valdez valdes zavala solis trejo espinoza espinosa escobar esparza carrillo cano zamora zuniga salinas sandoval serrano villanueva villarreal trevino quintero
quezada robles rosales rangel palacios orozco oseguera zambada beltran leyva arellano felix coronel caro carrasco fonseca fernandez tapia galvan garza gallegos guerra huerta
jaramillo lozano macias maldonado meza mejia miranda molina montes montoya nava olvera osorio paredes parra ponce rocha rubio saavedra segura sepulveda sierra suarez tellez
tovar uribe valencia valenzuela vega vera villalobos yanez yepez zepeda acosta aguirre anaya arriaga arias barajas barrera barragan bautista becerra benitez bernal blanco
bravo briones bustamante calderon camacho cantu carbajal cazares cepeda cisneros corona correa davalos duarte duran elizondo enriquez escamilla esquivel figueroa franco
gallardo gaxiola godinez granados guevara ibanez inzunza lerma limon loera lugo madrigal magana marin mata mireles monreal murillo murguia nieto noriega olivas olmos oropeza
pantoja patino peraza plascencia preciado pulido quinones renteria reynoso rosas salcido salgado sarabia sotelo tamayo terrazas toledo urias urrea valadez vallejo varela vela
velarde verdugo villegas zaragoza zarate amezcua abrego cazarez cuen ojeda quintana treviño morales`;

export const GIVEN_NAMES = new Set(GIVEN.split(/\s+/).filter(Boolean));
export const SURNAMES_SET = new Set(SURNAMES.split(/\s+/).filter(Boolean));

// Words that appear capitalized in headlines and institutional prose but are not name parts.
const STOP = `a an the and or of for by with from to in on at as is was were be been who what when where why how this that these those his her their its our your my
five six seven eight nine ten two three four one dozen hundred thousand million billion first second third last next new old young big small large high low long short
north south east west northern southern eastern western central upper lower inner outer greater united states america american mexican mexico canada world international
global local regional public private official special general chief senior junior deputy assistant associate acting former current late early spring summer autumn winter
today tomorrow yesterday week month year decade century time day night morning evening afternoon hour minute moment life death dead living killing murder homicide massacre
attack assault shooting bombing explosion fire crash accident disaster emergency crisis war battle fight conflict violence crime criminal gang mafia mob syndicate network
ring cell faction wing branch unit squad brigade regiment battalion platoon corps fleet squadron lights underground tunnel tunnels naval academy car bomb use system team age
lab laboratory command federation protection control fraud felon biological diversity harbor train grand canyon base air stadium chronicle gym memorial daily meet class fall
fellows now strong executive order case number no attention great questions republican democratic candidates candidate fifty shades rocky point transportation albuquerque sister brother father mother son daughter heart immaculate says said charges charge removal operations operation divisions division resources natural
civil assets foreign interrogates lookouts laser venerate operative operatives axe blockades across response towers cooks adaptation targets networks storm tropical island
village mills connection between investigation field alert issues suppression executes communique gunmen shootout killed arrested captured charged sentenced indicted pleads
pleaded guilty prison years months federal court judge national homeland security task force border patrol agents officers officials authorities cartel drug drugs fentanyl
meth methamphetamine cocaine heroin marijuana weapons guns firearms money laundering smuggling smuggler smugglers trafficking trafficker traffickers human migrants aliens
alien illegal immigration customs enforcement attorney office justice department government president governor mayor senator congressman congresswoman secretary minister
police army navy marines guard military soldiers troops forces state city county municipality region valley river lake mountain desert coast beach port bridge highway road
street avenue plaza park hotel restaurant bar club casino ranch farm house home building tower school university college hospital church cathedral jail airport station
market mall store shop bank company corporation group organization association foundation institute center centre museum library theater theatre cinema radio television
newspaper magazine journal times post herald tribune news press media report story article podcast video photo image map chart data statistics numbers percent texas
arizona california nuevo nueva santa san rio río ciudad puerto villa fort lake mount saint st los las el la de del y agency bureau administration service services
commission committee council board authority ministry secretariat directorate headquarters detention facility compound safe safehouse stash warehouse vehicle vehicles truck
trucks bus plane aircraft boat ship vessel drone drones rifle rifles pistol pistols grenade grenades ammunition rounds magazines kilos kilograms pounds tons liters gallons
dollars pesos cash currency gold silver diamonds oil fuel gas water food medicine hospital clinic pharmacy who was were been being has have had do does did will would shall
should may might must can could about after before during since until while although because unless whether though yet still already just only also even ever never always
sometimes often usually rarely seldom here there everywhere nowhere somewhere anywhere inside outside above below over under through across along around between among
within without against toward towards upon onto into out up down off back away forward backward again once twice thrice indicted convicted acquitted extradited deported
detained released escaped fled surrendered captured rescued freed kidnapped abducted executed murdered slain shot stabbed beaten tortured burned dismembered decapitated
found discovered located identified confirmed denied announced declared reported revealed alleged accused suspected wanted sought hunted tracked traced linked tied
connected related involved implicated exposed uncovered dismantled seized confiscated recovered destroyed burned raided searched arrested`;
export const STOP_WORDS = new Set(STOP.split(/\s+/).filter(Boolean));

// Context that marks a capitalized phrase as a person.
export const PERSON_CUE_BEFORE = /(?:\b(?:mr|mrs|ms|sr|sra|don|doña|dona|dr|alias|aka|a\.k\.a\.|named|name[ds]?\s+as|identified\s+as|known\s+as|defendant|co-defendant|suspect|suspects|leader|boss|capo|jefe|lieutenant|operator|operative|gunman|sicario|hitman|kingpin|trafficker|smuggler|fugitive|nephew|son|daughter|wife|husband|brother|sister|father|mother|journalist|reporter|activist|priest|mayor|governor|senator|congressman|congresswoman|secretary|prosecutor|agent|judge|attorney|sheriff|officer|detective|commander|general|colonel|captain|sergeant|lawyer|spokesman|spokeswoman|director|chief|president|candidate|businessman|businesswoman|national|citizen|resident|man|woman|teen|teenager|boy|girl|victim|victims)\b[,:]?\s*(?:[A-Z][a-z]*\.?\s+)?)$/i;
export const PERSON_CUE_AFTER = /^(?:[,’']?\s*(?:\(?\d{2}\)?|age[d]?\s+\d{2}|of\s+[A-Z]|alias|a\.k\.a\.|aka|also\s+known\s+as|known\s+as|apodad[oa]|conocid[oa]\s+como|who\b|whose\b|was\s+(?:arrested|detained|killed|shot|sentenced|charged|indicted|convicted|extradited|captured|found|taken|identified|kidnapped|executed|murdered|deported|released)|pleaded|pled|faces|received|said|told|testified|admitted|announced|declared|denied|confessed|is\s+(?:accused|charged|wanted|believed|alleged|suspected|considered)|has\s+been|had\s+been|will\s+be|were\s+(?:arrested|detained|killed|sentenced|charged|indicted))|\s*\(\s*(?:alias|aka|a\.k\.a\.)?\s*["“'‘]?(?:El|La|Los|Las)\s)/i;

export function lexiconScore(tokens) {
  let n = 0;
  for (const t of tokens) if (GIVEN_NAMES.has(t) || SURNAMES_SET.has(t)) n++;
  return n;
}
